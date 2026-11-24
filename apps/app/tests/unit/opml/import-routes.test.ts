import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type * as Evidence from "~/server/feeds/revalidationEvidence";
import type * as RetryWrite from "~/server/db/retry-write";
import type * as Subscriptions from "~/server/subscriptions/helpers";
import type * as Invalidation from "~/server/reconciliation/invalidation";
import type { ORPCContext } from "~/server/orpc/base";
import { createFromSubscriptionImport } from "~/server/api/routers/feed-router";
import { streamingImport } from "~/server/api/routers/initialRouter";
import { readOriginEvidence } from "~/server/feeds/revalidationEvidence";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  feedCategories,
  feedOrigins,
  feeds,
  user,
  viewFeeds,
} from "~/server/db/schema";
import { newRssFeedDetails } from "~/server/rss/types";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { dbSemaphore } from "~/lib/semaphore";

const state = vi.hoisted((): { database: unknown } => ({
  database: undefined,
}));
vi.mock("~/server/db", () => ({
  get db() {
    return state.database;
  },
}));
vi.mock("~/server/auth", () => ({ auth: {} }));
vi.mock("~/server/api/publisher", () => ({
  publisher: { publish: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("~/server/reconciliation/invalidation", async (original) => ({
  ...(await original<typeof Invalidation>()),
  publishReconciliationInvalidation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/server/subscriptions/helpers", async (original) => ({
  ...(await original<typeof Subscriptions>()),
  getFeedsActivationBudget: vi
    .fn()
    .mockResolvedValue({ remainingSlots: 1, maxActiveFeeds: 1 }),
}));
vi.mock("~/server/rss/fetchFeeds", () => ({
  fetchNewFeedDetails: vi.fn(),
  fetchAndInsertFeedData: async function* () {
    yield* [];
  },
}));
vi.mock("~/server/feeds/revalidationEvidence", async (original) => ({
  ...(await original<typeof Evidence>()),
  readOriginEvidence: vi.fn(),
}));
vi.mock("~/server/db/retry-write", async (original) => {
  const actual = await original<typeof RetryWrite>();
  return { ...actual, runDatabaseWrite: vi.fn(actual.runDatabaseWrite) };
});

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const rss = newRssFeedDetails({
  name: "RSS",
  url: "https://example.com/rss",
  platform: "website",
  siteUrl: "https://example.com",
});
const api = () =>
  createRouterClient(
    { bulk: createFromSubscriptionImport, streaming: streamingImport },
    {
      context: {
        headers: new Headers(),
        session: { id: "session" },
        user: { id: "owner" },
        db: fixture.database,
      } as ORPCContext,
    },
  );
beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createBookmarkTestDatabase();
  state.database = fixture.database;
  await fixture.database.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    isActive: false,
    details: {
      // A name its reader chose, which an origin that joins must not replace.
      name: "Custom",
      nameEditedAt: new Date(),
      platform: "website",
      siteUrl: "https://example.com",
      origins: [
        {
          kind: "atproto",
          locator: "at://did:plc:example/site.standard.publication/site",
        },
      ],
    },
  });
  vi.mocked(fetchNewFeedDetails).mockResolvedValue([rss]);
  vi.mocked(readOriginEvidence).mockImplementation(async (origin) => ({
    origin,
    siteUrl: "https://example.com",
    itemUrls: new Set(["https://example.com/article"]),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  fixture.cleanup();
});

it("does not commit a streaming import after preparation times out", async () => {
  vi.useFakeTimers();
  let finishPreparation: ((details: Array<typeof rss>) => void) | undefined;
  vi.mocked(fetchNewFeedDetails).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPreparation = resolve;
      }),
  );

  const eventsPromise = (async () => {
    const events = [];
    for await (const event of await api().streaming({
      feeds: [{ feedUrl: rss.origins[0]!.locator, categories: [] }],
    }))
      events.push(event);
    return events;
  })();
  await vi.advanceTimersByTimeAsync(15_000);
  const events = await eventsPromise;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "import-feed-error",
      error: "Import timed out",
    }),
  );

  finishPreparation?.([rss]);
  await vi.runAllTimersAsync();
  await Promise.resolve();
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
});

it.each(["bulk", "streaming"] as const)(
  "%s OPML attaches verified origins and preserves existing organization",
  async (route) => {
    if (route === "bulk") {
      expect(
        await api().bulk({
          feeds: [
            { feedUrl: "https://example.com/rss", categories: ["Imported"] },
          ],
        }),
      ).toMatchObject([{ success: true }]);
    } else {
      const events = [];
      for await (const event of await api().streaming({
        feeds: [
          {
            feedUrl: "https://example.com/rss",
            categories: ["Imported"],
            tagNames: ["Imported tag"],
          },
        ],
      }))
        events.push(event);
      expect(
        events.some((event) => event.type === "import-feed-inserted"),
      ).toBe(true);
      expect(
        events.some((event) => event.type === "import-limit-warning"),
      ).toBe(false);
    }
    expect(await fixture.database.select().from(feeds)).toMatchObject([
      { name: "Custom", isActive: false },
    ]);
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
    expect(await fixture.database.select().from(feedCategories)).toHaveLength(
      0,
    );
    expect(await fixture.database.select().from(viewFeeds)).toHaveLength(0);
  },
);

it.each(["bulk", "streaming"] as const)(
  "%s OPML reports an ambiguous candidate without creating a duplicate",
  async (route) => {
    vi.mocked(readOriginEvidence).mockImplementation(async (origin) => ({
      origin,
      itemUrls: new Set([`https://example.com/${origin.kind}`]),
    }));
    if (route === "bulk") {
      expect(
        await api().bulk({
          feeds: [{ feedUrl: "https://example.com/rss", categories: [] }],
        }),
      ).toMatchObject([
        { success: false, error: expect.stringContaining("Skipped") },
      ]);
    } else {
      const events = [];
      for await (const event of await api().streaming({
        feeds: [{ feedUrl: "https://example.com/rss", categories: [] }],
      }))
        events.push(event);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "import-feed-error",
          error: expect.stringContaining("Skipped"),
        }),
      );
    }
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
  },
);

it("streaming OPML treats a second address of a new Feed as already added", async () => {
  vi.mocked(fetchNewFeedDetails).mockResolvedValue([
    newRssFeedDetails({
      name: "Other",
      url: "https://other.example/feed",
      platform: "website",
      siteUrl: "https://other.example",
    }),
  ]);
  let release = () => {};
  vi.mocked(runDatabaseWrite).mockClear();
  const held = runDatabaseWrite(
    fixture.database,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const events: Array<{ type: string; feedId?: number; status?: string }> = [];
  const importing = (async () => {
    for await (const event of await api().streaming({
      feeds: [
        {
          feedUrl: "https://other.example/feed",
          categories: ["First"],
          tagNames: ["One"],
        },
        {
          feedUrl: "https://other.example/rss",
          categories: ["Second"],
          tagNames: ["Two"],
        },
      ],
    }))
      events.push(event);
  })();
  try {
    // The held write, then one queued commit per address: both addresses
    // have finished preparing before either commits.
    await vi.waitFor(() => expect(runDatabaseWrite).toHaveBeenCalledTimes(3), {
      timeout: 5000,
    });
  } finally {
    release();
    await held;
    await importing;
  }
  expect(events.filter((event) => event.type === "import-feed-error")).toEqual(
    [],
  );
  const inserted = events.filter(
    (event) => event.type === "import-feed-inserted",
  );
  expect(inserted).toHaveLength(1);
  expect(events).toContainEqual({
    type: "feed-status",
    feedId: inserted[0]!.feedId,
    status: "skipped",
  });
  // Both entries' sections and tags are on the one Feed.
  expect(await fixture.database.select().from(viewFeeds)).toMatchObject([
    { feedId: inserted[0]!.feedId },
    { feedId: inserted[0]!.feedId },
  ]);
  expect(await fixture.database.select().from(feedCategories)).toHaveLength(2);
});

it.each(["bulk", "streaming"] as const)(
  "%s OPML waits for the write queue without holding a connection slot",
  async (route) => {
    const feedInputs = Array.from({ length: 3 }, () => ({
      feedUrl: "https://example.com/rss",
      categories: [],
    }));
    const importFeeds = async () => {
      if (route === "bulk")
        return void (await api().bulk({ feeds: feedInputs }));
      for await (const event of await api().streaming({ feeds: feedInputs }))
        void event;
    };
    let release = () => {};
    vi.mocked(runDatabaseWrite).mockClear();
    const held = runDatabaseWrite(
      fixture.database,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    // Two imports overlap: six writes queue behind the held one, more than
    // the five connection slots.
    const imports = Promise.all([importFeeds(), importFeeds()]);
    try {
      await vi.waitFor(
        () => expect(runDatabaseWrite).toHaveBeenCalledTimes(7),
        { timeout: 5000 },
      );
      await expect(dbSemaphore.run(async () => "free")).resolves.toBe("free");
    } finally {
      release();
      await held;
      await imports;
    }
  },
);

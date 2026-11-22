import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { RecoveryOutcome } from "~/server/jetstream/recovery";
import type * as StreamStore from "~/server/jetstream/store";
import {
  atprotoStreamState,
  feedOriginAtproto,
  feedOrigins,
  user,
} from "~/server/db/schema";
import {
  fetchableOriginsOf,
  insertFeedWithOrigins,
} from "~/server/feeds/origins";
import {
  fetchAndInsertFeedData,
  STREAM_BACKSTOP_RECHECK_MS,
} from "~/server/rss/fetchFeeds";

const refresh = vi.hoisted(
  (): { outcome: RecoveryOutcome; afterRefresh: () => Promise<void> } => ({
    outcome: { status: "polled" },
    afterRefresh: async () => {},
  }),
);

vi.mock("~/server/logger", () => ({
  captureException: vi.fn(),
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("~/lib/constants", () => ({ IS_MAIN_INSTANCE: true }));
vi.mock("~/lib/demo", () => ({ IS_DEMO_INSTANCE: false }));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));
vi.mock("~/server/rss/feedCache", () => ({
  getCachedFeedResult: vi.fn(() => Promise.resolve(null)),
  setCachedFeedResult: vi.fn(() => Promise.resolve()),
}));
vi.mock("~/server/jetstream/service", async () => {
  const store = await vi.importActual<typeof StreamStore>(
    "~/server/jetstream/store",
  );
  return {
    originStillAppliesLive: store.originStillAppliesLive,
    refreshStreamOrigin: async (
      _database: unknown,
      fetchable: { feed: { id: number }; origin: { id: number } },
    ) => {
      await refresh.afterRefresh();
      return {
        result: {
          status: "empty",
          id: fetchable.feed.id,
          originId: fetchable.origin.id,
        },
        outcome: refresh.outcome,
      };
    },
  };
});

const HOUR_MS = 60 * 60 * 1000;
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let originId: number;

/** Runs the generic fetch path for the stream origin and returns its new schedule. */
async function scheduleAfter(outcome: RecoveryOutcome) {
  refresh.outcome = outcome;
  const feed = (await fixture.database.query.feeds.findFirst())!;
  const origin = (await fixture.database
    .select()
    .from(feedOrigins)
    .where(eq(feedOrigins.id, originId))
    .get())!;
  const atproto = (await fixture.database
    .select()
    .from(feedOriginAtproto)
    .where(eq(feedOriginAtproto.originId, originId))
    .get())!;
  const started = Date.now();
  for await (const result of fetchAndInsertFeedData(
    { db: fixture.database },
    fetchableOriginsOf([
      { ...feed, origins: [{ ...origin, rss: null, atproto }] },
    ]),
  ))
    expect(result.status).toBe("empty");
  const row = await fixture.database
    .select({ nextFetchAt: feedOrigins.nextFetchAt })
    .from(feedOrigins)
    .where(eq(feedOrigins.id, originId))
    .get();
  return { nextFetchAt: row!.nextFetchAt, started, finished: Date.now() };
}

/** Schedules are stored in whole seconds. */
function expectWithin(
  actual: Date | null,
  window: { started: number; finished: number },
  offsetMs: number,
) {
  expect(actual!.getTime()).toBeGreaterThanOrEqual(
    Math.floor((window.started + offsetMs) / 1000) * 1000,
  );
  expect(actual!.getTime()).toBeLessThanOrEqual(window.finished + offsetMs);
}

beforeEach(async () => {
  refresh.afterRefresh = async () => {};
  fixture = await createBookmarkTestDatabase();
  const now = new Date();
  await fixture.database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const feed = await insertFeedWithOrigins(fixture.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Publication",
      platform: "website",
      imageUrl: "",
      origins: [
        {
          kind: "atproto",
          locator: "at://did:plc:alice/site.standard.publication/site",
        },
      ],
    },
  });
  originId = feed.origins[0]!.id;
  await fixture.database
    .insert(atprotoStreamState)
    .values({ id: "primary", service: "https://jetstream.example.com" });
  await fixture.database
    .update(feedOriginAtproto)
    .set({ initialized: true, streamMode: "live", streamGeneration: 0 });
});

afterEach(() => fixture.cleanup());

describe("a stream origin's fetch schedule", () => {
  it("waits out the backstop recheck when the stream covers the origin", async () => {
    const window = await scheduleAfter({ status: "covered" });
    expectWithin(window.nextFetchAt, window, STREAM_BACKSTOP_RECHECK_MS);
    expect(STREAM_BACKSTOP_RECHECK_MS).toBe(6 * HOUR_MS);
  });

  it("polls on the default interval when nothing covers the origin", async () => {
    const window = await scheduleAfter({ status: "polled" });
    expectWithin(window.nextFetchAt, window, HOUR_MS);
  });

  it("stays due when a bounded attempt left work behind", async () => {
    const window = await scheduleAfter({ status: "unfinished" });
    expect(window.nextFetchAt!.getTime()).toBeLessThanOrEqual(window.finished);
  });

  it("waits for a failed recovery's backoff, or an hour when it left none", async () => {
    const retryAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 40_000);
    expect(
      (await scheduleAfter({ status: "deferred", retryAt })).nextFetchAt,
    ).toEqual(retryAt);
    await fixture.database
      .update(feedOrigins)
      .set({ nextFetchAt: new Date(0) });
    const window = await scheduleAfter({ status: "deferred", retryAt: null });
    expectWithin(window.nextFetchAt, window, HOUR_MS);
  });

  it.each([
    ["the stream paused the origin", { streamMode: "paused" as const }],
    ["the stream began a new generation", { generation: 1 }],
  ])("keeps the origin due when %s during its refresh", async (_, change) => {
    const due = new Date(Math.floor(Date.now() / 1000) * 1000);
    refresh.afterRefresh = async () => {
      if ("generation" in change)
        await fixture.database.update(atprotoStreamState).set(change);
      else await fixture.database.update(feedOriginAtproto).set(change);
      await fixture.database.update(feedOrigins).set({ nextFetchAt: due });
    };
    expect((await scheduleAfter({ status: "covered" })).nextFetchAt).toEqual(
      due,
    );
  });

  it("leaves an origin unscheduled when its Feed was deactivated during the refresh", async () => {
    refresh.afterRefresh = async () => {
      await fixture.database.update(feedOrigins).set({ nextFetchAt: null });
    };
    expect((await scheduleAfter({ status: "polled" })).nextFetchAt).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { NewFeedDetails } from "~/server/rss/types";
import {
  atprotoConnections,
  feedOriginChecks,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { PublicationGoneError } from "~/server/feeds/importErrors";
import { PublicationUnavailableError } from "~/server/feeds/publications";
import { backfillPublicationOrigin } from "~/server/origin-checks/backfill";
import {
  queueFeedRevalidation,
  queuePublicationBackfill,
} from "~/server/origin-checks/queue";
import {
  CHECKS_PER_USER,
  runFeedOriginChecks,
} from "~/server/origin-checks/worker";
import { persistAtprotoSyncSettings } from "~/server/auth/atproto/sync-settings";
import { wakeRequestedSync } from "~/server/publication-sync/wake";
import { newRssFeedDetails } from "~/server/rss/types";

// The real wake would start a sync run against the PDS.
vi.mock("~/server/publication-sync/wake", () => ({
  wakeRequestedSync: vi.fn(),
}));

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const did = "did:plc:abcdefghijklmnopqrstuvwx";
const uri = `at://${did}/site.standard.publication/blog`;
const evidence = (urls = ["https://example.com/article"]) => ({
  origin: { kind: "atproto", locator: uri, sourceName: "Publication" },
  siteUrl: "https://example.com",
  itemUrls: new Set(urls),
});
const readOriginEvidence = vi.fn(() =>
  Promise.resolve({
    ...evidence(),
    origin: { kind: "rss", locator: "https://example.com/rss" },
  }),
);
const publication = vi.fn<() => Promise<ReturnType<typeof evidence> | null>>();
const revalidate = vi.fn<() => Promise<unknown>>();
const release = vi.fn();
const acquireDiscovery = vi.fn(() => ({ ok: true as const, release }));
const publish = vi.fn(async () => {});
const backfill = vi.fn(
  (database: typeof fixture.database, userId: string, feedId: number) =>
    backfillPublicationOrigin(database, userId, feedId, {
      readOriginEvidence,
      readBackfillPublication: publication,
    }),
);
const run = () =>
  runFeedOriginChecks(fixture.database, {
    backfill,
    revalidate,
    acquireDiscovery,
    publish,
  });
const addFeed = (id: number, details?: Partial<NewFeedDetails>) =>
  insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: {
      ...newRssFeedDetails({
        name: `Feed ${id}`,
        platform: "website",
        url: `https://example.com/rss/${id}`,
        siteUrl: "https://example.com",
      }),
      ...details,
    },
    isActive: false,
  });
const checks = () =>
  fixture.database
    .select()
    .from(feedOriginChecks)
    .orderBy(feedOriginChecks.feedId);
/** Time passes until every queued check is due. */
const makeDue = () =>
  fixture.database.update(feedOriginChecks).set({ nextAttemptAt: new Date(0) });

beforeEach(async () => {
  // Each mock goes back to the implementation it was created with.
  vi.resetAllMocks();
  publication.mockResolvedValue(evidence());
  revalidate.mockResolvedValue(undefined);
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values(
    ["owner", "other"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
});
afterEach(() => fixture.cleanup());

describe("Publication backfill", () => {
  it("attaches an overlapping publication without an Atmosphere connection, keeps a custom inactive Feed, and finishes", async () => {
    const feed = await addFeed(1);
    await fixture.database
      .update(feeds)
      .set({ name: "My name", nameEditedAt: new Date() })
      .where(eq(feeds.id, feed.id));
    await queuePublicationBackfill(fixture.database, "owner");
    await run();
    expect(await fixture.database.select().from(feeds).get()).toMatchObject({
      id: feed.id,
      name: "My name",
      isActive: false,
    });
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
    expect(await checks()).toEqual([]);
    await run();
    expect(publication).toHaveBeenCalledTimes(1);
  });

  it("finishes without attaching a declaration whose articles do not overlap", async () => {
    await addFeed(1);
    publication.mockResolvedValue(evidence(["https://example.com/other"]));
    await queuePublicationBackfill(fixture.database, "owner");
    await run();
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
    expect(await checks()).toEqual([]);
  });

  it("retries a failure once its backoff is due", async () => {
    await addFeed(1);
    publication.mockRejectedValueOnce(new Error("timeout"));
    await queuePublicationBackfill(fixture.database, "owner");
    await run();
    const [waiting] = await checks();
    expect(waiting).toMatchObject({ type: "light", attempts: 1 });
    expect(waiting!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await run();
    expect(publication).toHaveBeenCalledTimes(1);
    await makeDue();
    await run();
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
    expect(await checks()).toEqual([]);
  });

  it("backs off a dead RSS feed to once a day and stops after 14 days", async () => {
    await addFeed(1);
    readOriginEvidence.mockRejectedValue(
      new Error("Unable to read the RSS Feed"),
    );
    await queuePublicationBackfill(fixture.database, "owner");
    const delays: number[] = [];
    let waited = 0;
    for (;;) {
      const before = Date.now();
      // Each pass is the next retry of the same check.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await run();
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const [check] = await checks();
      if (!check) break;
      const delay = check.nextAttemptAt.getTime() - before;
      delays.push(Math.round(delay / 60_000));
      waited += delay;
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await makeDue();
    }
    expect(delays.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(Math.max(...delays)).toBe(24 * 60);
    const day = 86_400_000;
    expect(waited - delays.at(-1)! * 60_000).toBeLessThan(14 * day);
    expect(waited).toBeGreaterThanOrEqual(14 * day);
  });

  it.each([
    new PublicationGoneError("Record is invalid"),
    new PublicationUnavailableError("Deleted publication"),
  ])("finishes at once when the publication is gone: %s", async (error) => {
    await addFeed(1);
    publication.mockRejectedValue(error);
    await queuePublicationBackfill(fixture.database, "owner");
    await run();
    expect(publication).toHaveBeenCalledTimes(1);
    expect(await checks()).toEqual([]);
  });

  it("does not attach a publication another Feed holds", async () => {
    await addFeed(1);
    await queuePublicationBackfill(fixture.database, "owner");
    await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: {
        name: "Existing",
        platform: "website",
        origins: [evidence().origin],
      },
      isActive: true,
    });
    await run();
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
    expect(await checks()).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("asks an exporting connection to sync the publication, resuming stopped writes", async () => {
    await fixture.database.insert(atprotoConnections).values({
      id: "connection",
      userId: "owner",
      did,
      session: "encrypted",
      scopes: "atproto include:site.standard.authSocial",
      exportSubscriptions: true,
      subscriptionRepoRev: "1",
      subscriptionWriteFailures: 25,
    });
    await addFeed(1);
    await queuePublicationBackfill(fixture.database, "owner");
    await run();
    expect(
      await fixture.database.select().from(atprotoConnections).get(),
    ).toMatchObject({
      subscriptionNextAttemptAt: expect.any(Date),
      subscriptionRepoRev: null,
      subscriptionWriteFailures: 0,
    });
    expect(wakeRequestedSync).toHaveBeenCalledWith(fixture.database, true);
  });
});

describe("the queue", () => {
  it("queues backfill only for text Feeds without an Atmosphere origin", async () => {
    const rss = await addFeed(1);
    await addFeed(2, { platform: "youtube" });
    await addFeed(3, { origins: [evidence().origin] });
    await queuePublicationBackfill(fixture.database, "owner");
    expect(await checks()).toEqual([
      expect.objectContaining({ feedId: rss.id, type: "light", attempts: 0 }),
    ]);
  });

  it("turns queued backfill into revalidation, and leaves queued revalidation alone", async () => {
    const one = await addFeed(1);
    const two = await addFeed(2);
    const others = await insertFeedWithOrigins(fixture.database, {
      userId: "other",
      details: newRssFeedDetails({
        name: "Not yours",
        platform: "website",
        url: "https://example.com/rss/other",
      }),
      isActive: true,
    });
    await queuePublicationBackfill(fixture.database, "owner");
    await queueFeedRevalidation(fixture.database, "owner", [
      one.id,
      two.id,
      others.id,
    ]);
    expect((await checks()).map(({ feedId, type }) => [feedId, type])).toEqual([
      [one.id, "full"],
      [two.id, "full"],
    ]);
    // A revalidation in progress keeps its claim; backfill never replaces it.
    const claimed = new Date(Date.now() + 60_000);
    await fixture.database
      .update(feedOriginChecks)
      .set({ nextAttemptAt: claimed })
      .where(eq(feedOriginChecks.feedId, one.id));
    await queueFeedRevalidation(fixture.database, "owner", [one.id]);
    await queuePublicationBackfill(fixture.database, "owner");
    expect(await checks()).toContainEqual(
      expect.objectContaining({
        feedId: one.id,
        type: "full",
        nextAttemptAt: claimed,
      }),
    );
  });

  it("queues existing Feeds the first time export is enabled since the link", async () => {
    await fixture.database.insert(atprotoConnections).values({
      id: "connection",
      userId: "owner",
      did,
      session: "encrypted",
      scopes: "atproto include:site.standard.authSocial",
    });
    await addFeed(1);
    const save = (method: "none" | "import" | "export") =>
      persistAtprotoSyncSettings(
        {
          userId: "owner",
          did,
          preferences: { method, importAsInactive: false },
        },
        fixture.database,
      );
    await save("import");
    expect(await checks()).toEqual([]);
    expect(await save("export")).toBe(true);
    expect(await checks()).toHaveLength(1);
    await fixture.database.delete(feedOriginChecks);
    await save("none");
    await save("export");
    expect(await checks()).toEqual([]);
    // Disconnecting starts over, so the next link queues them again.
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionBackfillStarted: false });
    await save("export");
    expect(await checks()).toHaveLength(1);
  });
});

describe("the worker", () => {
  it("checks two Feeds at a time per user until none is due", async () => {
    for (let i = 0; i < 11; i++) await addFeed(i);
    let active = 0,
      maximum = 0;
    publication.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return null;
    });
    await queuePublicationBackfill(fixture.database, "owner");
    expect(await run()).toBe(false);
    expect(publication).toHaveBeenCalledTimes(11);
    expect(maximum).toBe(CHECKS_PER_USER);
    expect(await checks()).toEqual([]);
  });

  it("leaves a Feed whose run stopped mid-check to come due again", async () => {
    await addFeed(1);
    await queuePublicationBackfill(fixture.database, "owner");
    let finishStopped: (attached: boolean) => void = () => {};
    backfill.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStopped = resolve;
        }),
    );
    const stopped = run();
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1));
    const [claimed] = await checks();
    expect(claimed!.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 60_000,
    );
    // Another worker leaves the claimed Feed alone.
    await run();
    expect(backfill).toHaveBeenCalledTimes(1);
    // Once the claim runs out, the Feed is checked again.
    await makeDue();
    await run();
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
    expect(await checks()).toEqual([]);
    finishStopped(false);
    await stopped;
  });

  it("revalidates a Feed queued for revalidation while its backfill ran", async () => {
    const feed = await addFeed(1);
    await queuePublicationBackfill(fixture.database, "owner");
    publication.mockImplementationOnce(async () => {
      await queueFeedRevalidation(fixture.database, "owner", [feed.id]);
      return null;
    });
    await run();
    expect(revalidate).toHaveBeenCalledExactlyOnceWith(
      fixture.database,
      "owner",
      feed.id,
    );
    expect(await checks()).toEqual([]);
  });
});

describe("Feed revalidation", () => {
  it("runs once in a discovery slot and finishes whatever the outcome", async () => {
    const one = await addFeed(1);
    const two = await addFeed(2);
    revalidate.mockRejectedValueOnce(new Error("Site unavailable"));
    await queueFeedRevalidation(fixture.database, "owner", [one.id, two.id]);
    await run();
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(acquireDiscovery).toHaveBeenCalledWith("owner");
    expect(release).toHaveBeenCalledTimes(2);
    expect(await checks()).toEqual([]);
    expect(backfill).not.toHaveBeenCalled();
  });

  it("waits for a discovery slot without spending its attempt", async () => {
    const feed = await addFeed(1);
    acquireDiscovery.mockReturnValueOnce({
      ok: false,
      reason: "capacity_limited",
    } as never);
    await queueFeedRevalidation(fixture.database, "owner", [feed.id]);
    await run();
    expect(revalidate).not.toHaveBeenCalled();
    const [waiting] = await checks();
    expect(waiting).toMatchObject({ type: "full", attempts: 0 });
    expect(waiting!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await makeDue();
    await run();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(await checks()).toEqual([]);
  });

  it("tells open clients about changed Feeds in batches", async () => {
    const feedIds = [];
    for (let i = 0; i < 6; i++) feedIds.push((await addFeed(i)).id);
    await queueFeedRevalidation(fixture.database, "owner", feedIds);
    await run();
    expect(revalidate).toHaveBeenCalledTimes(6);
    // The first change at once, and the rest together when the run ends.
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith("owner");
  });
});

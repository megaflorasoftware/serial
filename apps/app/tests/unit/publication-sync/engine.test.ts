import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, isNotNull } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type {
  SubscriptionRecord,
  SubscriptionRecordStore,
} from "~/server/publication-sync/record-store";
import type { TwoStageProgress } from "~/lib/two-stage-progress";
import { syncPublicationSubscriptions } from "~/server/publication-sync/engine";
import { runPublicationSyncJobs } from "~/server/publication-sync/jobs";
import { listingDigest } from "~/server/publication-sync/check";
import {
  atprotoConnections,
  atprotoSubscriptionMirror,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import {
  FeedImportDeferredError,
  FeedImportSkippedError,
  PublicationGoneError,
} from "~/server/feeds/importErrors";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { persistAtprotoSyncSettings } from "~/server/auth/atproto/sync-settings";
import { requestSyncForFeedChange } from "~/server/publication-sync/requests";
import { deleteFeedsAtUserRequest } from "~/server/feeds/delete";
import { wakeRequestedSync } from "~/server/publication-sync/wake";

// The real wake would start a second run beside the one under test.
vi.mock("~/server/publication-sync/wake", () => ({
  wakeRequestedSync: vi.fn(),
}));

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const did = "did:plc:abcdefghijklmnopqrstuvwx";
const publication = (name: string) =>
  `at://${did}/site.standard.publication/${name}`;
const record = (name: string, rkey = name): SubscriptionRecord => ({
  uri: `at://${did}/site.standard.graph.subscription/${rkey}`,
  cid: `cid-${rkey}`,
  publicationUri: publication(name),
});
const details = (uri: string) => ({
  name: uri.split("/").at(-1)!,
  platform: "website" as const,
  origins: [{ kind: "atproto", locator: uri }],
});
let records: SubscriptionRecord[];
let rev: number;
let store: SubscriptionRecordStore;
let resolveFeed: ReturnType<
  typeof vi.fn<
    (
      userId: string,
      uri: string,
      signal?: AbortSignal,
    ) => Promise<ReturnType<typeof details>>
  >
>;
let invalidate: ReturnType<typeof vi.fn<() => Promise<void>>>;
let fetchCreatedFeed: ReturnType<
  typeof vi.fn<(database: unknown, feed: { id: number }) => Promise<void>>
>;
let maxActiveFeeds: number;
const run = (onProgress?: (progress: TwoStageProgress) => void) =>
  syncPublicationSubscriptions({
    database: fixture.database,
    userId: "owner",
    onProgress: ({ stage, completed, total }) => {
      onProgress?.({ stage, completed, total });
      return Promise.resolve();
    },
    dependencies: {
      store,
      resolveFeed: (userId, uri, signal) => resolveFeed(userId, uri, signal),
      fetchCreatedFeed: (database, feed) => fetchCreatedFeed(database, feed),
      invalidate,
      activationBudget: async () => ({
        remainingSlots: maxActiveFeeds,
        maxActiveFeeds,
      }),
    },
  });
/** Jobs for an account whose refresh the client owns, so no recurring check follows. */
const runJobs = (sync: typeof syncPublicationSubscriptions) =>
  runPublicationSyncJobs(fixture.database, sync, {
    refreshesInBackground: async () => false,
  });
/** A fetch visits every origin of the Feed and moves its schedule on, whatever it finds. */
const visit = (feedId: number) =>
  fixture.database
    .update(feedOrigins)
    .set({ nextFetchAt: new Date(Date.now() + 60 * 60 * 1000) })
    .where(eq(feedOrigins.feedId, feedId));
/** A Feed the user added, which Add fetched at once. */
const addLocal = async (name: string) => {
  const feed = await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: details(publication(name)),
    isActive: true,
  });
  await visit(feed.id);
  return feed;
};
const method = (
  method: "none" | "import" | "export" | "bidirectional",
  importAsInactive = false,
) =>
  persistAtprotoSyncSettings(
    { userId: "owner", did, preferences: { method, importAsInactive } },
    fixture.database,
  );

/**
 * Time passes: every waiting retry falls due, in the mirror and on the
 * connection. Stopped writes have no time to fall due.
 */
const makeRetriesDue = async () => {
  await fixture.database
    .update(atprotoSubscriptionMirror)
    .set({ importRetryAt: new Date(0) });
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionRetryAt: new Date(0) });
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionWriteRetryAt: new Date(0) })
    .where(isNotNull(atprotoConnections.subscriptionWriteRetryAt));
};

beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await fixture.database.insert(atprotoConnections).values({
    id: "connection",
    did,
    userId: "owner",
    session: "encrypted",
    scopes: "atproto include:site.standard.authSocial",
  });
  records = [];
  rev = 1;
  maxActiveFeeds = 10;
  resolveFeed = vi.fn(async (_userId: string, uri: string) => details(uri));
  invalidate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  fetchCreatedFeed = vi.fn<
    (database: unknown, feed: { id: number }) => Promise<void>
  >(async (_database, feed) => {
    await visit(feed.id);
  });
  store = {
    visibility: "public",
    latestRev: vi.fn(async () => String(rev)),
    list: vi.fn(async () => ({ records: [...records], invalidRecordUris: [] })),
    create: vi.fn(async (uri) => {
      const value = record(uri.split("/").at(-1));
      records.push(value);
      rev++;
      return value;
    }),
    remove: vi.fn(async (value) => {
      records = records.filter((row) => row.uri !== value.uri);
      rev++;
    }),
  };
});
afterEach(() => fixture.cleanup());

describe("publication subscription sync", () => {
  it("fetches each active Feed it creates once, after the Feed is visible", async () => {
    records = [record("one"), record("two")];
    await method("import");
    expect(await run()).toMatchObject({ status: "completed", imported: 2 });
    const created = await fixture.database.select().from(feeds);
    expect(fetchCreatedFeed.mock.calls.map(([, feed]) => feed.id)).toEqual(
      created.map((feed) => feed.id),
    );
    for (const [
      index,
      order,
    ] of fetchCreatedFeed.mock.invocationCallOrder.entries())
      expect(invalidate.mock.invocationCallOrder[index]).toBeLessThan(order);
    fetchCreatedFeed.mockClear();
    await run();
    expect(fetchCreatedFeed).not.toHaveBeenCalled();
  });
  it("does not fetch inactive imports or Feeds that already exist", async () => {
    await addLocal("one");
    maxActiveFeeds = 1;
    records = [record("one"), record("two")];
    await method("import");
    expect(await run()).toMatchObject({ imported: 1, inactive: 1 });
    expect(fetchCreatedFeed).not.toHaveBeenCalled();
  });
  it("keeps the import when the first fetch or its announcement fails", async () => {
    records = [record("one"), record("two")];
    fetchCreatedFeed.mockRejectedValue(new Error("offline"));
    invalidate.mockRejectedValueOnce(new Error("publisher down"));
    await method("import");
    expect(await run()).toMatchObject({
      status: "completed",
      imported: 2,
      deferred: 0,
    });
    const created = await fixture.database.select().from(feeds);
    expect(created).toHaveLength(2);
    expect(
      (await fixture.database.select().from(atprotoSubscriptionMirror)).map(
        (row) => row.feedId,
      ),
    ).toEqual(expect.arrayContaining(created.map((feed) => feed.id)));
  });
  it("imports quota overflow inactive and skips unchanged repository listings", async () => {
    maxActiveFeeds = 1;
    records = [record("one"), record("two")];
    await method("import");
    expect(await run()).toMatchObject({
      status: "completed",
      imported: 2,
      inactive: 1,
    });
    expect(
      (await fixture.database.select().from(feeds)).filter(
        (feed) => feed.isActive,
      ),
    ).toHaveLength(1);
    await run();
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(resolveFeed).toHaveBeenCalledTimes(2);
    expect(
      await fixture.database.select().from(atprotoSubscriptionMirror),
    ).toHaveLength(2);
  });
  it("applies the explicit inactive preference without changing reused Feeds", async () => {
    const local = await addLocal("existing");
    records = [record("existing"), record("new")];
    await method("import", true);
    expect(await run()).toMatchObject({ imported: 1, inactive: 1 });
    expect(
      await fixture.database
        .select()
        .from(feeds)
        .where(eq(feeds.id, local.id))
        .get(),
    ).toMatchObject({ isActive: true });
  });
  it("exports existing local Feeds additively and uses pre-existing alternate record keys", async () => {
    await addLocal("one");
    await addLocal("two");
    records = [record("one", "alternate")];
    await method("export");
    expect(await run()).toMatchObject({ exported: 1 });
    expect(store.create).toHaveBeenCalledExactlyOnceWith(publication("two"));
    expect(records).toHaveLength(2);
  });
  it("does not resurrect an upstream deletion in bidirectional mode", async () => {
    await addLocal("one");
    await method("bidirectional");
    await run();
    records = [];
    rev++;
    expect(await run()).toMatchObject({ removed: 1, exported: 0 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
    expect(await run()).toMatchObject({ imported: 0, exported: 0, removed: 0 });
    expect(records).toHaveLength(0);
  });
  it("deletes every duplicate after local deletion, but keeps a Feed while a duplicate remains upstream", async () => {
    records = [record("one", "a"), record("one", "b")];
    await method("bidirectional");
    await run();
    records = records.slice(1);
    rev++;
    expect(await run()).toMatchObject({ removed: 0 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
    records.push(record("one", "c"));
    rev++;
    await fixture.database.delete(feeds);
    expect(await run()).toMatchObject({ removed: 1, imported: 0 });
    expect(records).toHaveLength(0);
    await run();
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
  });
  it("keeps one-way local deletions deleted until a new upstream subscription appears", async () => {
    records = [record("one")];
    await method("import");
    await run();
    await fixture.database.delete(feeds);
    await run();
    await run();
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
    records = [];
    rev++;
    await run();
    records = [record("one", "new")];
    rev++;
    expect(await run()).toMatchObject({ imported: 1 });
  });
  it("re-enables import additively without replaying paused deletions", async () => {
    records = [record("one")];
    await method("import");
    await run();
    await method("none");
    records = [];
    rev++;
    await method("import");
    expect(await run()).toMatchObject({ removed: 0 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
  });
  it("re-enables export without replaying paused local deletions", async () => {
    await addLocal("one");
    await method("export");
    await run();
    await method("none");
    await fixture.database.delete(feeds);
    await method("export");
    expect(await run()).toMatchObject({ removed: 0 });
    expect(records).toHaveLength(1);
  });
  it("retains successful publications and retries failures even with an unchanged repo revision", async () => {
    records = [record("bad"), record("good")];
    await method("import");
    resolveFeed.mockImplementation(async (_user, uri) => {
      if (uri === publication("bad")) throw new Error("temporary");
      return details(uri);
    });
    expect(await run()).toMatchObject({
      status: "partial",
      imported: 1,
      deferred: 1,
    });
    resolveFeed.mockImplementation(async (_user, uri) => details(uri));
    await makeRetriesDue();
    expect(await run()).toMatchObject({ status: "completed", imported: 1 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(2);
  });
  it("never infers removals from an incomplete or changing listing", async () => {
    records = [record("one")];
    await method("import");
    await run();
    rev++;
    // The check cannot read the listing and neither can the run it leaves it to.
    vi.mocked(store.list)
      .mockRejectedValueOnce(new Error("page failed"))
      .mockRejectedValueOnce(new Error("page failed"));
    expect(await run()).toMatchObject({ status: "partial", removed: 0 });
    vi.mocked(store.latestRev)
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");
    records = [];
    expect(await run()).toMatchObject({ status: "partial", removed: 0 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
  });

  it("keeps a Feed whose record is missing from a listing read at no known revision", async () => {
    records = [record("one"), record("two")];
    await method("bidirectional");
    await run();
    records = [record("two")];
    rev++;
    // The revision cannot be read, so nothing vouches for the listing.
    vi.mocked(store.latestRev).mockResolvedValueOnce(null);
    expect(await run()).toMatchObject({
      status: "partial",
      removed: 0,
      failed: 1,
    });
    expect(await fixture.database.select().from(feeds)).toHaveLength(2);
    // The next check reads the revision and trusts the same listing.
    expect(await run()).toMatchObject({ status: "completed", removed: 1 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
  });
  it("rejects concurrent runs and stops committing after settings change", async () => {
    records = [record("one")];
    await method("import");
    resolveFeed.mockImplementation(async (_user, uri) => {
      expect(await run()).toMatchObject({ status: "busy" });
      await method("none");
      return details(uri);
    });
    expect(await run()).toMatchObject({ status: "partial", imported: 0 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
    expect(
      await fixture.database.select().from(atprotoSubscriptionMirror),
    ).toHaveLength(0);
  });
  it("enforces the current grant on export, independently of saved preferences", async () => {
    await addLocal("one");
    await method("export");
    await fixture.database
      .update(atprotoConnections)
      .set({ scopes: "atproto" });
    expect(await run()).toMatchObject({ status: "partial", exported: 0 });
    expect(store.create).not.toHaveBeenCalled();
  });
  it("deactivation never changes repository records", async () => {
    const local = await addLocal("one");
    await method("bidirectional");
    await run();
    await fixture.database
      .update(feeds)
      .set({ isActive: false })
      .where(eq(feeds.id, local.id));
    expect(await run()).toMatchObject({ removed: 0, exported: 0 });
    expect(records).toHaveLength(1);
    expect(store.remove).not.toHaveBeenCalled();
  });
  it("skips disconnected and disabled connections without network requests", async () => {
    expect(await run()).toMatchObject({ status: "skipped" });
    await method("import");
    await fixture.database
      .update(atprotoConnections)
      .set({ status: "disconnected" });
    expect(await run()).toMatchObject({ status: "skipped" });
    expect(store.list).not.toHaveBeenCalled();
  });
});

it("keeps the Feed for an invalid known record while importing other publications", async () => {
  records = [record("one")];
  await method("import");
  await run();
  rev++;
  vi.mocked(store.list).mockResolvedValueOnce({
    records: [record("two")],
    invalidRecordUris: [record("one").uri],
  });
  expect(await run()).toMatchObject({ imported: 1, removed: 0, failed: 1 });
  expect(await fixture.database.select().from(feeds)).toHaveLength(2);
});
it("does not replay a successful baseline when another publication retries", async () => {
  records = [record("good"), record("bad")];
  await method("import");
  resolveFeed.mockImplementation(async (_user, uri) => {
    if (uri === publication("bad")) throw new Error("temporary");
    return details(uri);
  });
  await run();
  records = [record("bad")];
  rev++;
  expect(await run()).toMatchObject({ removed: 1, deferred: 1 });
  expect(await fixture.database.select().from(feeds)).toHaveLength(0);
});
it("keeps a direction's deletion history when only the inactive preference changes", async () => {
  records = [record("one")];
  await method("import");
  await run();
  await method("import", true);
  records = [];
  rev++;
  expect(await run()).toMatchObject({ removed: 1 });
});
it("aborts imported writes if the connection is unlinked during discovery", async () => {
  records = [record("one")];
  await method("import");
  resolveFeed.mockImplementation(async (_user, uri) => {
    await fixture.database
      .update(atprotoConnections)
      .set({ userId: null, session: null });
    return details(uri);
  });
  expect(await run()).toMatchObject({ imported: 0, failed: 1 });
  expect(await fixture.database.select().from(feeds)).toHaveLength(0);
});

it("persists throttled imports, honors backoff, and retries with an unchanged PDS revision", async () => {
  records = [record("limited"), record("good")];
  await method("import");
  resolveFeed.mockImplementation(async (_user, uri) => {
    if (uri === publication("limited"))
      throw new FeedImportDeferredError(
        undefined,
        new Date(Date.now() + 600_000),
      );
    return details(uri);
  });
  const first = await run();
  expect(first).toMatchObject({
    imported: 1,
    deferred: 1,
    failed: 0,
    status: "partial",
  });
  const rows = await fixture.database.select().from(atprotoSubscriptionMirror);
  const retryAt = rows.find(
    (row) => row.publicationUri === publication("limited"),
  )!.importRetryAt;
  // Mirror timestamps use seconds; queued deadlines retain milliseconds.
  expect(Math.floor(first.retryAt!.getTime() / 1000) * 1000).toBe(
    retryAt!.getTime(),
  );
  expect(
    rows.find((row) => row.publicationUri === publication("limited")),
  ).toMatchObject({ feedId: null, importState: "pending", importFailures: 1 });
  resolveFeed
    .mockClear()
    .mockImplementation(async (_user, uri) => details(uri));
  // A retry waiting for its time is all that is unfinished, so the revision
  // stays and the connection remembers when the retry falls due.
  expect(
    await fixture.database.select().from(atprotoConnections).get(),
  ).toMatchObject({
    subscriptionRepoRev: "1",
    subscriptionRetryAt: first.retryAt,
  });
  // Until then a run has nothing to do and reads nothing.
  expect(await run()).toMatchObject({
    imported: 0,
    deferred: 0,
    status: "completed",
  });
  expect(resolveFeed).not.toHaveBeenCalled();
  expect(store.list).toHaveBeenCalledTimes(1);
  await makeRetriesDue();
  expect(await run()).toMatchObject({
    imported: 1,
    deferred: 0,
    status: "completed",
  });
  expect(resolveFeed).toHaveBeenCalledExactlyOnceWith(
    "owner",
    publication("limited"),
    expect.any(AbortSignal),
  );
  // The repository did not change, so the retry reuses the stored snapshot.
  expect(store.list).toHaveBeenCalledTimes(1);
  expect(
    (await fixture.database.select().from(atprotoConnections).get())
      ?.subscriptionRetryAt,
  ).toBeNull();
  expect(
    (await fixture.database.select().from(atprotoSubscriptionMirror)).every(
      (row) => row.importState === null,
    ),
  ).toBe(true);
});
it("schedules queued import retries at their backoff deadline", async () => {
  records = [record("pending")];
  await method("import");
  const retryAt = new Date(Date.now() + 600_000);
  resolveFeed.mockRejectedValue(
    new FeedImportDeferredError(undefined, retryAt),
  );
  const sync = vi.fn(() => run());
  await runJobs(sync);
  expect(
    (await fixture.database.select().from(atprotoConnections).get())
      ?.subscriptionNextAttemptAt,
  ).toEqual(retryAt);
  await runJobs(sync);
  expect(sync).toHaveBeenCalledTimes(1);
});
it("reports ambiguous imports once without automatically retrying or exporting them", async () => {
  records = [record("ambiguous")];
  await method("bidirectional");
  resolveFeed.mockRejectedValue(new FeedImportSkippedError());
  expect(await run()).toMatchObject({
    skipped: 1,
    imported: 0,
    failed: 0,
    deferred: 0,
    status: "partial",
  });
  expect(await fixture.database.select().from(feeds)).toHaveLength(0);
  // Nothing changed, so the next run stops before looking at the publication.
  expect(await run()).toMatchObject({
    skipped: 0,
    imported: 0,
    exported: 0,
    status: "completed",
  });
  expect(resolveFeed).toHaveBeenCalledTimes(1);
  expect(store.create).not.toHaveBeenCalled();
  expect(store.remove).not.toHaveBeenCalled();
  records = [{ ...records[0]!, cid: "updated-cid" }];
  rev++;
  expect(await run()).toMatchObject({ skipped: 1, status: "partial" });
  expect(
    await fixture.database.select().from(atprotoSubscriptionMirror),
  ).toMatchObject([{ importState: "skipped", recordCid: "updated-cid" }]);
  expect(await run()).toMatchObject({ skipped: 0, status: "completed" });
  expect(resolveFeed).toHaveBeenCalledTimes(1);
});
it("drops a pending import when its upstream subscription disappears", async () => {
  records = [record("pending")];
  await method("import");
  resolveFeed.mockRejectedValue(new FeedImportDeferredError());
  await run();
  records = [];
  rev++;
  expect(await run()).toMatchObject({ imported: 0, deferred: 0 });
  expect(resolveFeed).toHaveBeenCalledTimes(1);
  expect(
    await fixture.database.select().from(atprotoSubscriptionMirror),
  ).toMatchObject([{ importState: null, remotePresent: false }]);
});
it("tombstones a removed duplicate while the remaining import is in backoff", async () => {
  records = [record("pending", "first"), record("pending", "second")];
  await method("import");
  resolveFeed.mockRejectedValue(new FeedImportDeferredError());
  await run();
  records = records.slice(1);
  rev++;
  await run();
  expect(resolveFeed).toHaveBeenCalledTimes(1);
  const rows = await fixture.database.select().from(atprotoSubscriptionMirror);
  expect(rows.find((row) => row.recordUri.endsWith("/first"))).toMatchObject({
    remotePresent: false,
    importState: null,
  });
  expect(rows.find((row) => row.recordUri.endsWith("/second"))).toMatchObject({
    remotePresent: true,
    importState: "pending",
    importFailures: 1,
  });
});
it("retains normal upstream-deletion semantics after a deferred import succeeds", async () => {
  records = [record("pending")];
  await method("bidirectional");
  resolveFeed.mockRejectedValueOnce(new FeedImportDeferredError());
  await run();
  await makeRetriesDue();
  expect(await run()).toMatchObject({ imported: 1 });
  records = [];
  rev++;
  expect(await run()).toMatchObject({ removed: 1, exported: 0 });
  expect(await fixture.database.select().from(feeds)).toHaveLength(0);
});

describe("deciding before a run", () => {
  const writes = () => {
    const spies = (["update", "insert", "delete", "transaction"] as const).map(
      (method) => vi.spyOn(fixture.database, method),
    );
    return () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  };
  const stored = async () =>
    (await fixture.database.select().from(atprotoConnections).get())!;

  it("claims nothing and writes nothing when neither side changed", async () => {
    records = [record("one")];
    await method("import");
    await run();
    expect((await stored()).subscriptionRepoRev).toBe("1");
    const written = writes();
    vi.mocked(store.latestRev).mockClear();
    expect(await run()).toMatchObject({ status: "completed", imported: 0 });
    expect(written()).toBe(0);
    expect(store.latestRev).toHaveBeenCalledTimes(1);
    expect(store.list).toHaveBeenCalledTimes(1);
  });
  it("runs in full when the subscriptions changed, reading the listing once", async () => {
    records = [record("one")];
    await method("import");
    await run();
    expect((await stored()).subscriptionListingDigest).toBe(
      listingDigest({ records, invalidRecordUris: [] }),
    );
    records.push(record("two"));
    rev++;
    vi.mocked(store.list).mockClear();
    expect(await run()).toMatchObject({ imported: 1 });
    // The run uses the listing its check read.
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: "2",
      subscriptionListingDigest: listingDigest({
        records,
        invalidRecordUris: [],
      }),
    });
  });
  it("stores a moved revision in one write when the subscriptions did not change", async () => {
    records = [record("one")];
    await method("import");
    await run();
    const before = await stored();
    // A post or a like moves the revision and leaves the subscriptions alone.
    rev++;
    vi.mocked(store.list).mockClear();
    const spies = (["update", "insert", "delete", "transaction"] as const).map(
      (name) => vi.spyOn(fixture.database, name),
    );
    expect(await run()).toMatchObject({ status: "completed", imported: 0 });
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 0, 0]);
    expect(store.list).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual({ ...before, subscriptionRepoRev: "2" });
    // The stored revision now answers the next check without a listing.
    vi.mocked(store.list).mockClear();
    expect(await run()).toMatchObject({ status: "completed" });
    expect(store.list).not.toHaveBeenCalled();
  });
  it("does not store a moved revision over a Feed change made while the listing was read", async () => {
    await method("export");
    await run();
    const local = await addLocal("one");
    rev++;
    vi.mocked(store.list).mockImplementationOnce(async () => {
      await requestSyncForFeedChange(fixture.database, "owner", [local.id]);
      return { records: [...records], invalidRecordUris: [] };
    });
    expect(await run()).toMatchObject({ status: "completed", exported: 0 });
    expect((await stored()).subscriptionRepoRev).toBeNull();
    expect(await run()).toMatchObject({ exported: 1 });
  });
  it("leaves the cursor and revision alone when a full pass changes neither", async () => {
    records = [record("one")];
    await method("import");
    await run();
    const before = await stored();
    const update = vi.spyOn(fixture.database, "update");
    await syncPublicationSubscriptions({
      database: fixture.database,
      userId: "owner",
      check: { state: "due" },
      dependencies: { store, invalidate },
    });
    // The claim and its release are the only connection writes.
    expect(update).toHaveBeenCalledTimes(2);
    expect(await stored()).toEqual(before);
  });
  it("reconciles a publication Feed the user added, and ignores one sync never heard about", async () => {
    await method("export");
    await run();
    const local = await addLocal("one");
    expect(await run()).toMatchObject({ exported: 0 });
    const before = await stored();
    await requestSyncForFeedChange(fixture.database, "owner", [local.id]);
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: null,
      subscriptionRequestId: before.subscriptionRequestId,
      subscriptionJobResult: before.subscriptionJobResult,
    });
    expect((await stored()).subscriptionNextAttemptAt).toBeInstanceOf(Date);
    expect(await run()).toMatchObject({ exported: 1 });
  });
  it("hears of a deletion the user asked for before the origins go", async () => {
    const local = await addLocal("one");
    await method("bidirectional");
    await run();
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: null });
    await deleteFeedsAtUserRequest(fixture.database, "owner", [local.id]);
    expect(await stored()).toMatchObject({ subscriptionRepoRev: null });
    expect((await stored()).subscriptionNextAttemptAt).toBeInstanceOf(Date);
    expect(wakeRequestedSync).toHaveBeenLastCalledWith(fixture.database, true);
    expect(await run()).toMatchObject({ removed: 1 });
    expect(records).toHaveLength(0);
  });
  it("does not request a run for Feeds without an Atmosphere origin or with sync off", async () => {
    const rss = await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: {
        name: "Plain",
        platform: "website",
        origins: [{ kind: "rss", locator: "https://example.com/rss" }],
      },
      isActive: true,
    });
    const local = await addLocal("one");
    await method("export");
    await run();
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: null });
    const clean = await stored();
    await requestSyncForFeedChange(fixture.database, "owner", [rss.id]);
    expect(await stored()).toEqual(clean);
    await fixture.database
      .update(atprotoConnections)
      .set({ exportSubscriptions: false });
    const disabled = await stored();
    await requestSyncForFeedChange(fixture.database, "owner", [local.id]);
    expect(await stored()).toEqual(disabled);
  });
  it("does not request another run for Feeds its own run imports or removes", async () => {
    records = [record("one")];
    await method("bidirectional");
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: null });
    expect(await run()).toMatchObject({ imported: 1 });
    expect(await stored()).toMatchObject({
      subscriptionNextAttemptAt: null,
      subscriptionRepoRev: "1",
    });
    records = [];
    rev++;
    expect(await run()).toMatchObject({ removed: 1 });
    expect(await stored()).toMatchObject({
      subscriptionNextAttemptAt: null,
      subscriptionRepoRev: "2",
    });
  });
  /** The user adds a publication Feed after the run has read the local origins. */
  const addFeedMidRun = (name: string) =>
    vi.mocked(store.list).mockImplementationOnce(async () => {
      const added = await addLocal(name);
      await requestSyncForFeedChange(fixture.database, "owner", [added.id]);
      return { records: [...records], invalidRecordUris: [] };
    });
  const expectStillRequested = async () => {
    const after = await stored();
    expect(after.subscriptionRepoRev).toBeNull();
    expect(after.subscriptionNextAttemptAt!.getTime()).toBeGreaterThan(0);
    expect(after.subscriptionNextAttemptAt!.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    return after;
  };
  it("keeps a Feed added during an inline run requested, and reconciles it next", async () => {
    await method("export");
    // Nothing is scheduled for an account whose refresh the client owns.
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: null });
    addFeedMidRun("late");
    expect(await run()).toMatchObject({ status: "completed", exported: 0 });
    await expectStillRequested();
    expect(await run()).toMatchObject({ exported: 1 });
  });
  it("keeps a Feed added during a job run requested, and still records that run's result", async () => {
    await method("export");
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: new Date(0) });
    addFeedMidRun("late");
    const sync: typeof syncPublicationSubscriptions = (input) =>
      syncPublicationSubscriptions({
        ...input,
        dependencies: { store, invalidate },
      });
    // The job reports more work, so the worker comes back without the timer.
    expect(await runJobs(sync)).toBe(true);
    expect(await expectStillRequested()).toMatchObject({
      subscriptionJobToken: null,
      subscriptionJobResult: { status: "completed", exported: 0 },
    });
    await runJobs(sync);
    expect(await stored()).toMatchObject({
      subscriptionJobResult: { exported: 1 },
    });
  });
  it("leaves a local-only publication alone when only import is on", async () => {
    await addLocal("one");
    await method("import");
    const transaction = vi.spyOn(fixture.database, "transaction");
    expect(await run()).toMatchObject({ status: "completed", exported: 0 });
    expect(transaction).not.toHaveBeenCalled();
    expect(
      await fixture.database.select().from(atprotoSubscriptionMirror),
    ).toHaveLength(0);
    expect((await stored()).subscriptionRepoRev).toBe("1");
  });
});

describe("failures that end or wait", () => {
  const stored = async () =>
    (await fixture.database.select().from(atprotoConnections).get())!;
  const mirrored = async () =>
    (await fixture.database.select().from(atprotoSubscriptionMirror).get())!;

  it.each([
    "Publication is unavailable",
    "The RSS Feed and publication cannot be combined",
  ])("stops importing a publication that is gone: %s", async (message) => {
    records = [record("gone")];
    await method("import");
    resolveFeed.mockRejectedValue(new PublicationGoneError(message));
    expect(await run()).toMatchObject({
      skipped: 1,
      deferred: 0,
      failed: 0,
      status: "partial",
    });
    expect(await mirrored()).toMatchObject({
      importState: "skipped",
      importRetryAt: null,
      importFailures: 1,
    });
    // Nothing waits for a retry, so the pass counts as finished.
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: "1",
      subscriptionRetryAt: null,
    });
    expect(await run()).toMatchObject({ status: "completed", skipped: 0 });
    expect(resolveFeed).toHaveBeenCalledTimes(1);
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
  });

  it("backs off a failing import to once a day and gives up after 14 days", async () => {
    records = [record("down")];
    await method("import");
    resolveFeed.mockRejectedValue(
      new FeedImportDeferredError(undefined, new Date(0)),
    );
    const delays: number[] = [];
    let waited = 0;
    for (;;) {
      const before = Date.now();
      // Each pass is the next retry of the same import.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const result = await run();
      if (result.skipped) break;
      expect(result).toMatchObject({ deferred: 1, skipped: 0 });
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const delay = (await stored()).subscriptionRetryAt!.getTime() - before;
      delays.push(Math.round(delay / 60_000));
      waited += delay;
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await makeRetriesDue();
    }
    expect(delays.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(Math.max(...delays)).toBe(24 * 60);
    // The last retry fell within 14 days of the first failure, and the wait
    // that followed it carried the total past them.
    const day = 86_400_000;
    expect(waited - delays.at(-1)! * 60_000).toBeLessThan(14 * day);
    expect(waited).toBeGreaterThanOrEqual(14 * day);
    expect(await mirrored()).toMatchObject({
      importState: "skipped",
      importRetryAt: null,
    });
    expect((await stored()).subscriptionRetryAt).toBeNull();
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
  });

  it("does not rerun in full for a record that stays invalid", async () => {
    records = [record("one")];
    await method("import");
    await run();
    rev++;
    vi.mocked(store.list).mockResolvedValueOnce({
      records: [],
      invalidRecordUris: [record("one").uri],
    });
    expect(await run()).toMatchObject({ failed: 1, removed: 0 });
    // The same revision would yield the same invalid record.
    expect((await stored()).subscriptionRepoRev).toBe("2");
    vi.mocked(store.list).mockClear();
    expect(await run()).toMatchObject({ status: "completed", failed: 0 });
    expect(store.list).not.toHaveBeenCalled();
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
  });

  it("reruns in full after a failure that has no retry time of its own", async () => {
    await addLocal("one");
    await method("export");
    // The grant is checked before any write is attempted.
    await fixture.database
      .update(atprotoConnections)
      .set({ scopes: "atproto" });
    expect(await run()).toMatchObject({ failed: 1, exported: 0 });
    expect(store.create).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: null,
      subscriptionRetryAt: null,
    });
    await fixture.database
      .update(atprotoConnections)
      .set({ scopes: "atproto include:site.standard.authSocial" });
    expect(await run()).toMatchObject({ exported: 1 });
  });

  it("waits to retry a refused export, with checks idle until then", async () => {
    await addLocal("one");
    await method("export");
    vi.mocked(store.create).mockRejectedValueOnce(
      new Error("PDS write failed"),
    );
    const before = Date.now();
    expect(await run()).toMatchObject({
      status: "partial",
      failed: 1,
      exported: 0,
    });
    const waiting = await stored();
    // The snapshot was complete and nothing was written, so the revision stands.
    expect(waiting).toMatchObject({
      subscriptionRepoRev: "1",
      subscriptionWriteFailures: 1,
    });
    const wait = waiting.subscriptionRetryAt!.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(60_000);
    expect(wait).toBeLessThan(2 * 60_000);
    // The write's own time is what the connection waits for.
    expect(waiting.subscriptionWriteRetryAt).toEqual(
      waiting.subscriptionRetryAt,
    );
    // Until the wait passes a check finds nothing to do and attempts no write.
    expect(await run()).toMatchObject({ status: "completed", exported: 0 });
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual(waiting);
    // The wait passes: one full pass retries the export from the cached snapshot.
    await makeRetriesDue();
    vi.mocked(store.list).mockClear();
    expect(await run()).toMatchObject({
      status: "completed",
      exported: 1,
      failed: 0,
    });
    expect(store.create).toHaveBeenCalledTimes(2);
    expect(store.list).not.toHaveBeenCalled();
    // A whole pass that owed no write ends the count.
    expect(await stored()).toMatchObject({
      subscriptionRetryAt: null,
      subscriptionWriteFailures: 0,
      subscriptionWriteRetryAt: null,
    });
  });

  it("backs off a refused export to once a day, stops after 14 days, and starts over when the user changes a Feed or saves settings", async () => {
    const local = await addLocal("one");
    await method("export");
    let refused = true;
    const create = vi.mocked(store.create);
    create.mockImplementation(async (uri) => {
      if (refused) throw new Error("PDS write failed");
      const value = record(uri.split("/").at(-1)!);
      records.push(value);
      rev++;
      return value;
    });
    const delays: number[] = [];
    let waited = 0;
    for (;;) {
      const before = Date.now();
      // Each pass is the next retry of the same export.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      expect(await run()).toMatchObject({ failed: 1, exported: 0 });
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const retryAt = (await stored()).subscriptionRetryAt;
      if (!retryAt) break;
      const delay = retryAt.getTime() - before;
      delays.push(Math.round(delay / 60_000));
      waited += delay;
      // A pass that starts inside the wait serves none of it.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await fixture.database
        .update(atprotoConnections)
        .set({ subscriptionRepoRev: null });
      const attempted = create.mock.calls.length;
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      expect(await run()).toMatchObject({ deferred: 1, failed: 0 });
      expect(create).toHaveBeenCalledTimes(attempted);
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      expect((await stored()).subscriptionWriteFailures).toBe(delays.length);
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await makeRetriesDue();
    }
    expect(delays.slice(0, 5)).toEqual([1, 2, 4, 8, 16]);
    expect(Math.max(...delays)).toBe(24 * 60);
    const day = 86_400_000;
    expect(waited - delays.at(-1)! * 60_000).toBeLessThan(14 * day);
    expect(waited).toBeGreaterThanOrEqual(14 * day);
    const attempts = create.mock.calls.length;
    expect(attempts).toBe(delays.length + 1);
    // The pass finished and nothing waits, so checks are idle.
    const stopped = await stored();
    expect(stopped).toMatchObject({
      subscriptionRepoRev: "1",
      subscriptionRetryAt: null,
      subscriptionWriteFailures: attempts,
      subscriptionWriteRetryAt: null,
    });
    expect(await run()).toMatchObject({ status: "completed" });
    // A run another app's change starts leaves the owed export unattempted.
    records.push(record("elsewhere"));
    rev++;
    expect(await run()).toMatchObject({ skipped: 1, failed: 0, exported: 0 });
    expect(create).toHaveBeenCalledTimes(attempts);
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: "2",
      subscriptionRetryAt: null,
      subscriptionWriteFailures: attempts,
    });
    // A Feed the user changes starts the retries over.
    const before = Date.now();
    await requestSyncForFeedChange(fixture.database, "owner", [local.id]);
    expect(await run()).toMatchObject({ failed: 1, exported: 0 });
    expect(create).toHaveBeenCalledTimes(attempts + 1);
    const restarted = await stored();
    expect(restarted.subscriptionWriteFailures).toBe(1);
    expect(restarted.subscriptionRetryAt!.getTime() - before).toBeLessThan(
      2 * 60_000,
    );
    // So does saving the connection settings.
    await fixture.database.update(atprotoConnections).set({
      subscriptionWriteFailures: attempts,
      subscriptionWriteRetryAt: null,
      subscriptionRetryAt: null,
    });
    await method("export");
    refused = false;
    expect(await run()).toMatchObject({ exported: 1, failed: 0 });
  });

  it("leaves a stopped removal unattempted until the user saves settings", async () => {
    records = [record("one")];
    await method("bidirectional");
    await run();
    // The user deleted the Feed, and the PDS refused the removal for 14 days.
    await fixture.database.delete(feeds);
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionRepoRev: null, subscriptionWriteFailures: 25 });
    expect(await run()).toMatchObject({ skipped: 1, removed: 0, failed: 0 });
    expect(store.remove).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: "1",
      subscriptionRetryAt: null,
      subscriptionWriteFailures: 25,
    });
    await method("bidirectional");
    expect(await run()).toMatchObject({ removed: 1 });
    expect(records).toHaveLength(0);
  });

  it("waits to retry a failed remote removal, and lists again once a removal landed", async () => {
    records = [record("one", "a"), record("one", "b")];
    await method("bidirectional");
    await run();
    // The user deleted the Feed, so both duplicate records are owed a removal.
    await fixture.database.delete(feeds);
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionRepoRev: null });
    vi.mocked(store.remove).mockRejectedValueOnce(
      new Error("PDS write failed"),
    );
    expect(await run()).toMatchObject({ failed: 1, removed: 0 });
    expect(records).toHaveLength(2);
    // Nothing was written: the revision stands and the removal waits.
    expect(await stored()).toMatchObject({ subscriptionRepoRev: "1" });
    expect((await stored()).subscriptionRetryAt).toBeInstanceOf(Date);
    expect(await run()).toMatchObject({ status: "completed", removed: 0 });
    await makeRetriesDue();
    // The first removal lands and the second fails: the repository changed.
    vi.mocked(store.remove)
      .mockImplementationOnce(async (value) => {
        records = records.filter((row) => row.uri !== value.uri);
        rev++;
      })
      .mockRejectedValueOnce(new Error("PDS write failed"));
    expect(await run()).toMatchObject({ failed: 1, removed: 0 });
    expect(records).toHaveLength(1);
    expect(await stored()).toMatchObject({
      subscriptionRepoRev: null,
      subscriptionWriteFailures: 2,
    });
    // A cleared revision lists the repository at once, and the removal that
    // is left still waits for its own time.
    vi.mocked(store.remove).mockClear();
    expect(await run()).toMatchObject({ deferred: 1, removed: 0 });
    expect(store.list).toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect((await stored()).subscriptionWriteFailures).toBe(2);
    await makeRetriesDue();
    expect(await run()).toMatchObject({ removed: 1 });
    expect(records).toHaveLength(0);
    expect(await fixture.database.select().from(feeds)).toHaveLength(0);
  });

  describe("a refused export waiting for its time", () => {
    /** The PDS refused the export of "one": one failure, a minute to wait. */
    const refuseExport = async (sync: "export" | "bidirectional") => {
      await addLocal("one");
      await method(sync);
      vi.mocked(store.create).mockRejectedValueOnce(
        new Error("PDS write failed"),
      );
      expect(await run()).toMatchObject({ failed: 1, exported: 0 });
      return stored();
    };
    /** The pass that follows reaches the export and leaves it waiting. */
    const expectExportLeftWaiting = async (
      waiting: Awaited<ReturnType<typeof stored>>,
      deferred = 1,
    ) => {
      const attempted = vi.mocked(store.create).mock.calls.length;
      expect(await run()).toMatchObject({ deferred, failed: 0, exported: 0 });
      expect(store.create).toHaveBeenCalledTimes(attempted);
      const after = await stored();
      expect(after).toMatchObject({
        subscriptionWriteFailures: waiting.subscriptionWriteFailures,
        subscriptionWriteRetryAt: waiting.subscriptionWriteRetryAt,
      });
      // The wait still stands on the connection, so later checks stay idle.
      expect(after.subscriptionRetryAt!.getTime()).toBeLessThanOrEqual(
        waiting.subscriptionWriteRetryAt!.getTime(),
      );
    };

    it("is left alone when an import retry falls due first", async () => {
      const waiting = await refuseExport("bidirectional");
      records.push(record("two"));
      rev++;
      resolveFeed.mockRejectedValue(new Error("offline"));
      expect(await run()).toMatchObject({ deferred: 2, imported: 0 });
      // Only the import's wait passes.
      await fixture.database
        .update(atprotoSubscriptionMirror)
        .set({ importRetryAt: new Date(0) });
      await fixture.database
        .update(atprotoConnections)
        .set({ subscriptionRetryAt: new Date(0) });
      resolveFeed.mockClear();
      // The import is tried again and waits again, beside the export.
      await expectExportLeftWaiting(waiting, 2);
      expect(resolveFeed).toHaveBeenCalledTimes(1);
    });

    it("is left alone when another app changes the listing", async () => {
      const waiting = await refuseExport("export");
      records.push(record("elsewhere"));
      rev++;
      vi.mocked(store.list).mockClear();
      await expectExportLeftWaiting(waiting);
      expect(store.list).toHaveBeenCalledTimes(1);
    });

    it("is left alone after a pass that ran out of time", async () => {
      const waiting = await refuseExport("bidirectional");
      records.push(record("two"));
      rev++;
      // Importing "two" takes the pass beyond its minute, before it reaches "one".
      const realNow = Date.now.bind(Date);
      let passed = 0;
      const clock = vi
        .spyOn(Date, "now")
        .mockImplementation(() => realNow() + passed);
      resolveFeed.mockImplementationOnce((_userId, uri) => {
        passed = 61_000;
        return Promise.resolve(details(uri));
      });
      try {
        expect(await run()).toMatchObject({ imported: 1, deferred: 1 });
      } finally {
        clock.mockRestore();
      }
      expect(store.create).toHaveBeenCalledTimes(1);
      expect(await stored()).toMatchObject({
        subscriptionRepoRev: null,
        subscriptionWriteFailures: 1,
        subscriptionWriteRetryAt: waiting.subscriptionWriteRetryAt,
      });
      // The unfinished pass is followed at once by one that reaches "one".
      await expectExportLeftWaiting(waiting);
    });

    it("is left alone after a failure that reruns the pass in full", async () => {
      await addLocal("one");
      const two = await addLocal("two");
      await method("export");
      // "one" is refused, and "two" loses its Feed before its turn.
      vi.mocked(store.create).mockImplementationOnce(async () => {
        await fixture.database.delete(feeds).where(eq(feeds.id, two.id));
        throw new Error("PDS write failed");
      });
      expect(await run()).toMatchObject({ failed: 2, exported: 0 });
      const waiting = await stored();
      expect(waiting).toMatchObject({
        subscriptionRepoRev: null,
        subscriptionWriteFailures: 1,
      });
      await expectExportLeftWaiting(waiting);
    });

    it("is left alone after another write landed in the same pass", async () => {
      await addLocal("one");
      await addLocal("two");
      await method("export");
      vi.mocked(store.create).mockRejectedValueOnce(
        new Error("PDS write failed"),
      );
      expect(await run()).toMatchObject({ failed: 1, exported: 1 });
      const waiting = await stored();
      // The export that landed changed the repository, so the next check runs.
      expect(waiting).toMatchObject({
        subscriptionRepoRev: null,
        subscriptionWriteFailures: 1,
      });
      await expectExportLeftWaiting(waiting);
      // Its time comes: one attempt, and the count ends with the owed write.
      await makeRetriesDue();
      expect(await run()).toMatchObject({ exported: 1, failed: 0 });
      expect(store.create).toHaveBeenCalledTimes(3);
      expect(await stored()).toMatchObject({
        subscriptionWriteFailures: 0,
        subscriptionWriteRetryAt: null,
      });
    });
  });
});

describe("finding, then fetching", () => {
  const name = (uri: string) => uri.split("/").at(-1)!;
  /** Runs past the deadline once `passed` is set, without waiting a minute. */
  const pastDeadline = () => {
    const realNow = Date.now.bind(Date);
    const clock = { passed: 0 };
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + clock.passed);
    return Object.assign(clock, { restore: () => spy.mockRestore() });
  };
  const stored = async () =>
    (await fixture.database.select().from(atprotoConnections).get())!;
  const createdNames = async () =>
    (
      await fixture.database
        .select({ name: feeds.name })
        .from(feeds)
        .orderBy(feeds.id)
    ).map((feed) => feed.name);

  it("finds every Feed before it fetches any, and counts each stage", async () => {
    records = [record("one"), record("two"), record("three")];
    await method("import");
    const events: string[] = [];
    resolveFeed.mockImplementation(async (_userId, uri) => {
      events.push("find");
      return details(uri);
    });
    fetchCreatedFeed.mockImplementation(async (_database, feed) => {
      events.push("fetch");
      await visit(feed.id);
    });
    const progress: TwoStageProgress[] = [];
    expect(
      await run((update) => {
        progress.push(update);
      }),
    ).toMatchObject({ status: "completed", imported: 3 });
    expect(events).toEqual(["find", "find", "find", "fetch", "fetch", "fetch"]);
    expect(progress.at(0)).toEqual({
      stage: "finding",
      completed: 0,
      total: 0,
    });
    expect(progress).toContainEqual({
      stage: "finding",
      completed: 3,
      total: 3,
    });
    expect(progress.at(-1)).toEqual({
      stage: "fetching",
      completed: 3,
      total: 3,
    });
    // Once fetching starts, finding never reports again.
    const fetching = progress.findIndex(
      (update) => update.stage === "fetching",
    );
    expect(
      progress.slice(fetching).every((update) => update.stage === "fetching"),
    ).toBe(true);
  });

  it("finds four publications at a time and commits each as it finishes", async () => {
    records = ["a", "b", "c", "d", "e"].map((rkey) => record(rkey));
    await method("import");
    const waiting = new Map<string, () => void>();
    let active = 0;
    let most = 0;
    resolveFeed.mockImplementation(
      (_userId, uri) =>
        new Promise((resolve) => {
          most = Math.max(most, ++active);
          waiting.set(name(uri), () => {
            active--;
            resolve(details(uri));
          });
        }),
    );
    const progress: TwoStageProgress[] = [];
    const syncing = run((update) => {
      progress.push(update);
    });
    await vi.waitFor(() =>
      expect([...waiting.keys()]).toEqual(["a", "b", "c", "d"]),
    );
    // "b" is found first and commits without waiting for "a".
    waiting.get("b")!();
    await vi.waitFor(() => expect(progress).toHaveLength(3));
    expect(await createdNames()).toEqual(["b"]);
    // Nothing before it has committed, so finding has not moved on.
    expect(progress.at(-1)).toEqual({
      stage: "finding",
      completed: 0,
      total: 5,
    });
    await vi.waitFor(() => expect(waiting.has("e")).toBe(true));
    for (const rkey of ["e", "d", "c", "a"]) waiting.get(rkey)!();
    expect(await syncing).toMatchObject({ imported: 5 });
    expect(most).toBe(4);
    expect((await createdNames()).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(progress).toContainEqual({
      stage: "finding",
      completed: 5,
      total: 5,
    });
    expect((await stored()).subscriptionSyncCursor).toBe(publication("e"));
  });

  it("resumes after the leading run, and counts what lies beyond it once", async () => {
    records = ["a", "b", "c", "d", "e"].map((rkey) => record(rkey));
    await method("import");
    const reported: TwoStageProgress[] = [];
    const sync: typeof syncPublicationSubscriptions = (input) =>
      syncPublicationSubscriptions({
        ...input,
        onProgress: async (update) => {
          const { stage, completed, total } = update;
          reported.push({ stage, completed, total });
          await input.onProgress?.(update);
        },
        dependencies: {
          store,
          invalidate,
          resolveFeed: (userId, uri, signal) =>
            resolveFeed(userId, uri, signal),
          fetchCreatedFeed: (database, feed) =>
            fetchCreatedFeed(database, feed),
          activationBudget: () =>
            Promise.resolve({ remainingSlots: maxActiveFeeds, maxActiveFeeds }),
        },
      });
    const requestProgress = async () =>
      (await stored()).subscriptionJobProgress;
    const waiting = new Map<string, () => void>();
    let slotTaken = true;
    resolveFeed.mockImplementation(
      (_userId, uri, signal) =>
        new Promise((resolve, reject) => {
          if (name(uri) === "b" && slotTaken) {
            // No discovery slot comes free before the run gives up its wait.
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            });
            return;
          }
          waiting.set(name(uri), () => resolve(details(uri)));
        }),
    );
    const clock = pastDeadline();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = runJobs(sync);
      await vi.waitFor(() =>
        expect([...waiting.keys()]).toEqual(["a", "c", "d"]),
      );
      waiting.get("c")!();
      await vi.waitFor(() => expect(waiting.has("e")).toBe(true));
      waiting.get("d")!();
      await vi.waitFor(async () =>
        expect(await createdNames()).toHaveLength(2),
      );
      // "c" and "d" committed, but nothing before them has.
      expect(await requestProgress()).toEqual({
        stage: "finding",
        completed: 0,
        total: 5,
      });
      waiting.get("a")!();
      await vi.waitFor(async () =>
        expect(await createdNames()).toHaveLength(3),
      );
      // The run's minute ends while "b" still waits, and "e" arrives after.
      clock.passed = 61_000;
      await vi.advanceTimersByTimeAsync(60_000);
      waiting.get("e")!();
      await first;
    } finally {
      vi.useRealTimers();
      clock.restore();
    }
    expect(await stored()).toMatchObject({
      subscriptionSyncCursor: publication("a"),
      subscriptionJobProgress: { stage: "finding", completed: 1, total: 5 },
      subscriptionJobResult: { imported: 4, deferred: 1 },
    });

    slotTaken = false;
    waiting.clear();
    reported.length = 0;
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: new Date(0) });
    const second = runJobs(sync);
    await vi.waitFor(() => expect(waiting.has("b")).toBe(true));
    // "c", "d", "e" and "a" are revisited at once, while "b" is still found.
    await vi.waitFor(() =>
      expect(reported.filter((update) => update.stage === "finding")).toEqual([
        { stage: "finding", completed: 0, total: 0 },
        ...Array.from({ length: 5 }, () => ({
          stage: "finding",
          completed: 0,
          total: 5,
        })),
      ]),
    );
    expect(await requestProgress()).toEqual({
      stage: "finding",
      completed: 1,
      total: 5,
    });
    waiting.get("b")!();
    await second;
    expect(resolveFeed.mock.calls.map(([, uri]) => name(uri))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "b",
    ]);
    expect(reported).toContainEqual({
      stage: "finding",
      completed: 5,
      total: 5,
    });
    expect(fetchCreatedFeed).toHaveBeenCalledTimes(5);
    expect(await stored()).toMatchObject({
      subscriptionSyncCursor: publication("a"),
      subscriptionJobProgress: null,
      subscriptionJobResult: { imported: 5, deferred: 0 },
    });
  });

  it("fetches the Feeds an earlier run found once a later run finishes finding", async () => {
    records = [record("one"), record("two")];
    await method("import");
    const clock = pastDeadline();
    // Finding "one" takes the run beyond its minute, so "two" waits.
    resolveFeed.mockImplementationOnce(async (_userId, uri) => {
      clock.passed = 61_000;
      return details(uri);
    });
    try {
      expect(await run()).toMatchObject({ imported: 1, deferred: 1 });
    } finally {
      clock.restore();
    }
    // Finding did not finish, so nothing was fetched and the pass stays open.
    expect(fetchCreatedFeed).not.toHaveBeenCalled();
    expect((await stored()).subscriptionRepoRev).toBeNull();
    expect(await run()).toMatchObject({ imported: 1, deferred: 0 });
    const created = await fixture.database.select().from(feeds);
    expect(
      fetchCreatedFeed.mock.calls.map(([, feed]) => feed.id).sort(),
    ).toEqual(created.map((feed) => feed.id).sort());
    expect((await stored()).subscriptionRepoRev).toBe("1");
  });

  it("leaves the first fetches it has no time for to the next run", async () => {
    records = ["a", "b", "c", "d", "e"].map((rkey) => record(rkey));
    await method("import");
    const clock = pastDeadline();
    // The first fetch to finish takes the run beyond its minute. Four start
    // together; the fifth would start after it.
    fetchCreatedFeed.mockImplementationOnce(async (_database, feed) => {
      clock.passed = 61_000;
      await visit(feed.id);
    });
    let result;
    try {
      result = await run();
    } finally {
      clock.restore();
    }
    expect(result).toMatchObject({ imported: 5, deferred: 0 });
    expect(result?.retryAt).toBeInstanceOf(Date);
    expect(fetchCreatedFeed).toHaveBeenCalledTimes(4);
    // The revision waits until every Feed found has its content.
    expect((await stored()).subscriptionRepoRev).toBeNull();
    const progress: TwoStageProgress[] = [];
    expect(
      await run((update) => {
        progress.push(update);
      }),
    ).toMatchObject({ imported: 0 });
    expect(fetchCreatedFeed).toHaveBeenCalledTimes(5);
    expect(progress.at(-1)).toEqual({
      stage: "fetching",
      completed: 1,
      total: 1,
    });
    expect((await stored()).subscriptionRepoRev).toBe("1");
  });

  it("does not fetch a Feed whose first fetch was already tried", async () => {
    records = [record("one")];
    await method("import");
    // A failed fetch still moves the schedule on, as the real one does.
    fetchCreatedFeed.mockImplementation(async (_database, feed) => {
      await visit(feed.id);
      throw new Error("offline");
    });
    expect(await run()).toMatchObject({ imported: 1 });
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionRepoRev: null });
    expect(await run()).toMatchObject({ imported: 0 });
    expect(fetchCreatedFeed).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or count a Feed again while its first fetch still runs", async () => {
    records = [record("one"), record("two")];
    await method("import");
    let finishSlowFetch = () => {};
    // The first fetch outlasts the run's wait for it and keeps running.
    fetchCreatedFeed.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSlowFetch = resolve;
        }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = run();
      await vi.waitFor(() => expect(fetchCreatedFeed).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await first).toMatchObject({ imported: 2 });
    } finally {
      vi.useRealTimers();
    }
    await fixture.database
      .update(atprotoConnections)
      .set({ subscriptionRepoRev: null });
    const progress: TwoStageProgress[] = [];
    await run((update) => {
      progress.push(update);
    });
    expect(fetchCreatedFeed).toHaveBeenCalledTimes(2);
    expect(progress.some((update) => update.stage === "fetching")).toBe(false);
    finishSlowFetch();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("fetches only the Feeds this connection imported", async () => {
    // A Feed an OPML import or Add Feed is still fetching for the first time.
    await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: details(publication("elsewhere")),
      isActive: true,
    });
    records = [record("one")];
    await method("import");
    expect(await run()).toMatchObject({ imported: 1 });
    const [imported] = await fixture.database
      .select()
      .from(feeds)
      .where(eq(feeds.name, "one"));
    expect(fetchCreatedFeed.mock.calls.map(([, feed]) => feed.id)).toEqual([
      imported!.id,
    ]);
  });

  it("only finds when the caller fetches every due origin next", async () => {
    records = [record("one")];
    await method("import");
    const progress: TwoStageProgress[] = [];
    expect(
      await syncPublicationSubscriptions({
        database: fixture.database,
        userId: "owner",
        skipFetching: true,
        onProgress: ({ stage }) => {
          progress.push({ stage, completed: 0, total: 0 });
          return Promise.resolve();
        },
        dependencies: {
          store,
          invalidate,
          resolveFeed: (userId, uri) => resolveFeed(userId, uri),
          fetchCreatedFeed: (database, feed) =>
            fetchCreatedFeed(database, feed),
          activationBudget: () =>
            Promise.resolve({ remainingSlots: 10, maxActiveFeeds: 10 }),
        },
      }),
    ).toMatchObject({ imported: 1, status: "completed" });
    expect(fetchCreatedFeed).not.toHaveBeenCalled();
    expect(progress.every((update) => update.stage === "finding")).toBe(true);
    // The refresh that follows fetches it, so the pass is finished.
    expect((await stored()).subscriptionRepoRev).toBe("1");
  });

  it("gives up finding's waits for discovery once finding ends", async () => {
    records = [record("one")];
    await method("import");
    await run();
    const [, , signal] = resolveFeed.mock.calls[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(true);
  });
});

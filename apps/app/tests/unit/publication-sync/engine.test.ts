import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type {
  SubscriptionRecord,
  SubscriptionRecordStore,
} from "~/server/publication-sync/record-store";
import { syncPublicationSubscriptions } from "~/server/publication-sync/engine";
import { runPublicationSyncJobs } from "~/server/publication-sync/jobs";
import {
  atprotoConnections,
  atprotoSubscriptionMirror,
  feeds,
  user,
} from "~/server/db/schema";
import {
  FeedImportDeferredError,
  FeedImportSkippedError,
} from "~/server/feeds/importErrors";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { persistAtprotoSyncSettings } from "~/server/auth/atproto/sync-settings";

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
    (userId: string, uri: string) => Promise<ReturnType<typeof details>>
  >
>;
let invalidate: ReturnType<typeof vi.fn<() => Promise<void>>>;
let fetchCreatedFeed: ReturnType<
  typeof vi.fn<(database: unknown, feedId: number) => Promise<void>>
>;
let maxActiveFeeds: number;
const run = () =>
  syncPublicationSubscriptions({
    database: fixture.database,
    userId: "owner",
    dependencies: {
      store,
      resolveFeed: (userId, uri) => resolveFeed(userId, uri),
      fetchCreatedFeed: (database, feedId) =>
        fetchCreatedFeed(database, feedId),
      invalidate,
      activationBudget: async () => ({
        remainingSlots: maxActiveFeeds,
        maxActiveFeeds,
      }),
    },
  });
const addLocal = (name: string) =>
  insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: details(publication(name)),
    isActive: true,
  });
const method = (
  method: "none" | "import" | "export" | "bidirectional",
  importAsInactive = false,
) =>
  persistAtprotoSyncSettings(
    { userId: "owner", did, preferences: { method, importAsInactive } },
    fixture.database,
  );

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
  fetchCreatedFeed = vi
    .fn<(database: unknown, feedId: number) => Promise<void>>()
    .mockResolvedValue(undefined);
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
    expect(fetchCreatedFeed.mock.calls.map(([, feedId]) => feedId)).toEqual(
      created.map((feed) => feed.id),
    );
    expect(invalidate.mock.invocationCallOrder[0]).toBeLessThan(
      fetchCreatedFeed.mock.invocationCallOrder[0]!,
    );
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
  it("keeps the import when the first fetch fails", async () => {
    records = [record("one")];
    fetchCreatedFeed.mockRejectedValue(new Error("offline"));
    await method("import");
    expect(await run()).toMatchObject({ status: "completed", imported: 1 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
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
    await fixture.database
      .update(atprotoSubscriptionMirror)
      .set({ importRetryAt: new Date(0) });
    expect(await run()).toMatchObject({ status: "completed", imported: 1 });
    expect(await fixture.database.select().from(feeds)).toHaveLength(2);
  });
  it("never infers removals from an incomplete or changing listing", async () => {
    records = [record("one")];
    await method("import");
    await run();
    rev++;
    vi.mocked(store.list).mockRejectedValueOnce(new Error("page failed"));
    expect(await run()).toMatchObject({ status: "partial", removed: 0 });
    vi.mocked(store.latestRev)
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");
    records = [];
    expect(await run()).toMatchObject({ status: "partial", removed: 0 });
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
  expect(await run()).toMatchObject({ imported: 0, deferred: 1, retryAt });
  expect(resolveFeed).not.toHaveBeenCalled();
  expect(store.list).toHaveBeenCalledTimes(1);
  await fixture.database
    .update(atprotoSubscriptionMirror)
    .set({ importRetryAt: new Date(0) });
  expect(await run()).toMatchObject({
    imported: 1,
    deferred: 0,
    status: "completed",
  });
  expect(resolveFeed).toHaveBeenCalledExactlyOnceWith(
    "owner",
    publication("limited"),
  );
  expect(store.list).toHaveBeenCalledTimes(1);
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
  await runPublicationSyncJobs(fixture.database, sync);
  expect(
    (await fixture.database.select().from(atprotoConnections).get())
      ?.subscriptionNextAttemptAt,
  ).toEqual(retryAt);
  await runPublicationSyncJobs(fixture.database, sync);
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
  expect(await run()).toMatchObject({
    skipped: 1,
    imported: 0,
    exported: 0,
    status: "partial",
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
  expect(await run()).toMatchObject({ skipped: 1, status: "partial" });
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
  await fixture.database
    .update(atprotoSubscriptionMirror)
    .set({ importRetryAt: new Date(0) });
  expect(await run()).toMatchObject({ imported: 1 });
  records = [];
  rev++;
  expect(await run()).toMatchObject({ removed: 1, exported: 0 });
  expect(await fixture.database.select().from(feeds)).toHaveLength(0);
});

it("persists continuation when a legacy enabled connection starts backfill during refresh", async () => {
  const { backfillPublicationOrigins, BACKFILL_BATCH_SIZE } =
    await import("~/server/publication-sync/backfill");
  await method("export");
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionRequestId: null, subscriptionNextAttemptAt: null });
  for (let i = 0; i < BACKFILL_BATCH_SIZE + 1; i++) {
    await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: {
        name: `Old feed ${i}`,
        platform: "website",
        siteUrl: "https://example.com",
        origins: [{ kind: "rss", locator: `https://example.com/rss/${i}` }],
      },
      isActive: false,
    });
  }
  const probe = vi.fn(() => Promise.resolve(null));
  const sync: typeof syncPublicationSubscriptions = (input) =>
    syncPublicationSubscriptions({
      ...input,
      dependencies: {
        store,
        invalidate,
        backfill: (database, connection) =>
          backfillPublicationOrigins(database, connection, {
            readOriginEvidence: (origin) =>
              Promise.resolve({
                origin: { ...origin },
                siteUrl: "https://example.com",
                itemUrls: new Set(["https://example.com/article"]),
              }),
            readBackfillPublication: probe,
          }),
      },
    });
  await sync({ database: fixture.database, userId: "owner" });
  expect(probe).toHaveBeenCalledTimes(BACKFILL_BATCH_SIZE);
  const pending = await fixture.database
    .select()
    .from(atprotoConnections)
    .get();
  expect(pending?.subscriptionRequestId).toEqual(expect.any(String));
  expect(pending?.subscriptionNextAttemptAt).toBeInstanceOf(Date);
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) });
  await runPublicationSyncJobs(fixture.database, sync);
  expect(probe).toHaveBeenCalledTimes(BACKFILL_BATCH_SIZE + 1);
  expect(
    (await fixture.database.select().from(atprotoConnections).get())
      ?.subscriptionNextAttemptAt,
  ).toBeNull();
});

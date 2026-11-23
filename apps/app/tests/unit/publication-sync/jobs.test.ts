import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { syncPublicationSubscriptions } from "~/server/publication-sync/engine";
import type { SubscriptionListing } from "~/server/publication-sync/record-store";
import { atprotoConnections, user } from "~/server/db/schema";
import { listingDigest } from "~/server/publication-sync/check";
import { persistAtprotoSyncSettings } from "~/server/auth/atproto/sync-settings";
import {
  getPublicationSyncJob,
  REMOTE_CHANGE_CHECK_INTERVAL_MS,
  runPublicationSyncJobs,
} from "~/server/publication-sync/jobs";
import { scheduleMissingSyncCheck } from "~/server/publication-sync/requests";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const did = "did:plc:abcdefghijklmnopqrstuvwx";
const save = (method: "export" | "none" = "export", expectedVersion?: number) =>
  persistAtprotoSyncSettings(
    {
      userId: "owner",
      did,
      preferences: { method, importAsInactive: false },
      expectedVersion,
    },
    fixture.database,
  );
const completed = () => ({
  ...emptyPublicationSyncCounts(),
  status: "completed" as const,
  exported: 1,
});
const subscription = (rkey: string, cid = `cid-${rkey}`) => ({
  uri: `at://${did}/site.standard.graph.subscription/${rkey}`,
  cid,
  publicationUri: `at://${did}/site.standard.publication/${rkey}`,
});
const listed = (
  ...records: Array<ReturnType<typeof subscription>>
): SubscriptionListing => ({ records, invalidRecordUris: [] });
/** A test that names no PDS answer must not reach the PDS. */
const unasked = async (): Promise<never> => {
  throw new Error("The check asked the PDS unexpectedly");
};
/** Jobs for an account whose refresh the client owns, unless a test says otherwise. */
const runJobs = (
  sync: typeof syncPublicationSubscriptions,
  options: {
    background?: boolean;
    latestRev?: () => Promise<string | null>;
    list?: () => Promise<SubscriptionListing>;
  } = {},
) =>
  runPublicationSyncJobs(fixture.database, sync, {
    refreshesInBackground: async () => options.background ?? false,
    remote: {
      latestRev: options.latestRev ?? unasked,
      list: options.list ?? unasked,
    },
    announce,
  });
const announce = vi.fn<(userId: string) => Promise<void>>(async () => {});
const connection = async () =>
  (await fixture.database
    .select()
    .from(atprotoConnections)
    .where(eq(atprotoConnections.id, "connection"))
    .get())!;
/**
 * A connection whose last run and backfill finished cleanly against `rev` and
 * the given listing, due for a check.
 */
const dueWithCleanRun = async (rev = "rev-1", listing = listed()) => {
  await save();
  await runJobs(async () => completed());
  await fixture.database
    .update(atprotoConnections)
    .set({
      subscriptionRepoRev: rev,
      subscriptionListingDigest: listingDigest(listing),
      subscriptionBackfillStarted: true,
      subscriptionNextAttemptAt: new Date(0),
    })
    .where(eq(atprotoConnections.id, "connection"));
  return connection();
};
beforeEach(async () => {
  announce.mockClear();
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
    userId: "owner",
    did,
    session: "encrypted",
    scopes: "atproto include:site.standard.authSocial",
  });
});
afterEach(() => fixture.cleanup());
it("persists work atomically with settings and runs without a browser", async () => {
  await save();
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: true,
    running: false,
    result: null,
  });
  const sync = vi.fn<typeof syncPublicationSubscriptions>(
    async ({ onProgress, runId }) => {
      expect(
        await getPublicationSyncJob(fixture.database, "owner"),
      ).toMatchObject({
        pending: true,
        running: true,
        progress: null,
      });
      await onProgress?.({ runId: runId!, completed: 1, total: 1 });
      return completed();
    },
  );
  await runJobs(sync);
  expect(sync).toHaveBeenCalledTimes(1);
  // A settled request gives up its progress and keeps its result.
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    running: false,
    progress: null,
    result: { exported: 1 },
  });
  expect(
    await getPublicationSyncJob(fixture.database, "someone-else"),
  ).toBeNull();
});
it("rejects stale consent without replacing pending work", async () => {
  await save();
  const original = await getPublicationSyncJob(fixture.database, "owner");
  expect(await save("export", 0)).toBe(false);
  expect(await getPublicationSyncJob(fixture.database, "owner")).toEqual(
    original,
  );
});
it("reclaims an expired worker after restart and defers a live worker", async () => {
  await save();
  await fixture.database.update(atprotoConnections).set({
    subscriptionJobToken: "dead-process",
    subscriptionJobExpiresAt: new Date(Date.now() + 60_000),
  });
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync);
  expect(sync).not.toHaveBeenCalled();
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionJobExpiresAt: new Date(0) });
  await runJobs(sync);
  expect(sync).toHaveBeenCalledTimes(1);
});
it("keeps a later save when an older worker finishes", async () => {
  await save();
  const first = await getPublicationSyncJob(fixture.database, "owner");
  await runJobs(async () => {
    await save();
    return completed();
  });
  const newer = await getPublicationSyncJob(fixture.database, "owner");
  expect(newer?.runId).not.toBe(first?.runId);
  expect(newer).toMatchObject({ pending: true, result: null });
  await runJobs(async () => completed());
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { exported: 1 },
  });
});
it("keeps a request in flight across an immediate continuation and totals its runs", async () => {
  await save();
  // A run that stops at its deadline leaves work for a continuation due now.
  const continued = await runJobs(async ({ onProgress, runId }) => {
    await onProgress?.({ runId: runId!, completed: 1, total: 2 });
    return {
      ...completed(),
      status: "partial",
      deferred: 1,
      retryAt: new Date(),
    };
  });
  expect(continued).toBe(true);
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: true,
    running: false,
    progress: { completed: 1, total: 2 },
    result: { exported: 1, deferred: 1 },
  });
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) })
    .where(eq(atprotoConnections.id, "connection"));
  await runJobs(async () => completed());
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    progress: null,
    result: { exported: 2, deferred: 0 },
  });
});
it("keeps the failures an earlier run of the same request saw, without counting them twice", async () => {
  await save();
  const due = () =>
    fixture.database
      .update(atprotoConnections)
      .set({ subscriptionNextAttemptAt: new Date(0) })
      .where(eq(atprotoConnections.id, "connection"));
  const stoppedAtDeadline = {
    ...completed(),
    status: "partial" as const,
    failed: 2,
    deferred: 1,
    retryAt: new Date(),
  };
  await runJobs(async () => stoppedAtDeadline);
  await due();
  // A continuation that lists the repository meets the same failures again.
  await runJobs(async () => stoppedAtDeadline);
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: true,
    result: { exported: 2, failed: 2 },
  });
  await due();
  // One that reads the cached snapshot cannot see them and reports none.
  await runJobs(async () => completed());
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { exported: 3, failed: 2, deferred: 0, status: "partial" },
  });
});
it("keeps what an in-flight request already did when a check finds nothing left", async () => {
  await save();
  await runJobs(async () => ({
    ...completed(),
    status: "partial",
    deferred: 1,
    retryAt: new Date(),
  }));
  // An inline run finished the rest before the continuation started.
  await fixture.database.update(atprotoConnections).set({
    subscriptionRepoRev: "rev-1",
    subscriptionBackfillStarted: true,
    subscriptionNextAttemptAt: new Date(0),
  });
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  await runJobs(sync, { latestRev: async () => "rev-1" });
  expect(sync).not.toHaveBeenCalled();
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    progress: null,
    result: { status: "completed", exported: 1, deferred: 0 },
  });
});
it("runs a retry in the background once its request has settled", async () => {
  await save();
  await runJobs(async () => ({
    ...completed(),
    status: "partial",
    deferred: 1,
    retryAt: new Date(Date.now() + 60_000),
  }));
  // A retry scheduled further out ends the request: its result shows once.
  const settled = await getPublicationSyncJob(fixture.database, "owner");
  expect(settled).toMatchObject({
    pending: false,
    running: false,
    progress: null,
    result: { exported: 1, deferred: 1 },
  });
  expect((await connection()).subscriptionNextAttemptAt).toBeInstanceOf(Date);
  announce.mockClear();
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) })
    .where(eq(atprotoConnections.id, "connection"));
  await runJobs(async ({ onProgress, runId }) => {
    await onProgress?.({ runId: runId!, completed: 1, total: 1 });
    // While it runs, the interface has nothing to watch.
    expect(
      await getPublicationSyncJob(fixture.database, "owner"),
    ).toMatchObject({ pending: false, running: true, progress: null });
    return completed();
  });
  // The retry wrote no job state, added nothing to the totals and said nothing.
  expect(await getPublicationSyncJob(fixture.database, "owner")).toEqual(
    settled,
  );
  expect(announce).not.toHaveBeenCalled();
});
it("announces a run the user started while it progresses and when it settles", async () => {
  await save();
  await runJobs(async ({ onProgress, runId }) => {
    await onProgress?.({ runId: runId!, completed: 0, total: 2 });
    // A second change inside the announcement interval waits for the next one.
    await onProgress?.({ runId: runId!, completed: 1, total: 2 });
    expect(announce).toHaveBeenCalledExactlyOnceWith("owner");
    return completed();
  });
  expect(announce).toHaveBeenCalledTimes(2);
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { exported: 1 },
  });
});
it("announces a change held back by the interval once the interval ends", async () => {
  await save();
  await runJobs(async ({ onProgress, runId }) => {
    await onProgress?.({ runId: runId!, completed: 0, total: 2 });
    await onProgress?.({ runId: runId!, completed: 1, total: 2 });
    expect(announce).toHaveBeenCalledTimes(1);
    // The run goes quiet, as during a slow import, and the held change still goes out.
    await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    return completed();
  });
  expect(announce).toHaveBeenCalledTimes(3);
});
it("keeps watching a request whose first run found sync busy", async () => {
  await save();
  await runJobs(async () => ({
    ...emptyPublicationSyncCounts(),
    status: "busy",
  }));
  // The run did nothing, so the request has no result and waits for the next one.
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: true,
    result: null,
  });
});
it("turning sync off cancels queued work", async () => {
  await save();
  await save("none");
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  await runJobs(sync);
  expect(sync).not.toHaveBeenCalled();
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
  });
});

it("finishes unclassified sync failures as partial instead of polling them forever", async () => {
  await save();
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue({ ...completed(), status: "partial", failed: 1 });
  await runJobs(sync);
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { status: "partial", failed: 1 },
  });
  await runJobs(sync);
  expect(sync).toHaveBeenCalledTimes(1);
});

it("ends an idle check with one reschedule and never claims the job", async () => {
  const before = await dueWithCleanRun();
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  const started = Date.now();
  await runJobs(sync, { background: true, latestRev: async () => "rev-1" });
  expect(sync).not.toHaveBeenCalled();
  const after = await connection();
  expect(after.subscriptionNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
    started + REMOTE_CHANGE_CHECK_INTERVAL_MS,
  );
  expect(after).toEqual({
    ...before,
    subscriptionNextAttemptAt: after.subscriptionNextAttemptAt,
  });
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    running: false,
    result: { exported: 1 },
  });
});
it("leaves a client-owned account unscheduled after an idle check", async () => {
  await dueWithCleanRun();
  await runJobs(vi.fn(), { latestRev: async () => "rev-1" });
  expect((await connection()).subscriptionNextAttemptAt).toBeNull();
});
it("runs when the subscriptions changed, handing the engine what it read", async () => {
  await dueWithCleanRun("rev-1", listed(subscription("one")));
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  const listing = listed(subscription("one"), subscription("two"));
  await runJobs(sync, {
    latestRev: async () => "rev-2",
    list: async () => listing,
  });
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]![0].check).toEqual({
    state: "due",
    rev: "rev-2",
    listing,
  });
});
it("stores a moved revision in one write and claims nothing when the subscriptions did not change", async () => {
  const listing = listed(subscription("one"), subscription("two"));
  const before = await dueWithCleanRun("rev-1", listing);
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  const list = vi.fn(async () => listed(...[...listing.records].reverse()));
  const update = vi.spyOn(fixture.database, "update");
  const started = Date.now();
  await runJobs(sync, {
    background: true,
    latestRev: async () => "rev-2",
    list,
  });
  expect(sync).not.toHaveBeenCalled();
  expect(list).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
  const after = await connection();
  expect(after.subscriptionNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
    started + REMOTE_CHANGE_CHECK_INTERVAL_MS,
  );
  // Only the revision and the schedule moved: no claim, no lease, no result.
  expect(after).toEqual({
    ...before,
    subscriptionRepoRev: "rev-2",
    subscriptionNextAttemptAt: after.subscriptionNextAttemptAt,
  });
});
it.each([
  ["a record was added", listed(subscription("one"), subscription("two"))],
  ["a record was removed", listed()],
  ["a record was rewritten", listed(subscription("one", "cid-edited"))],
  [
    "a record stopped parsing",
    { records: [], invalidRecordUris: [subscription("one").uri] },
  ],
])("runs when %s under a moved revision", async (_change, listing) => {
  await dueWithCleanRun("rev-1", listed(subscription("one")));
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync, {
    latestRev: async () => "rev-2",
    list: async () => listing,
  });
  expect(sync).toHaveBeenCalledTimes(1);
  expect((await connection()).subscriptionRepoRev).toBe("rev-1");
});
it("leaves a listing it cannot read for the run to read", async () => {
  await dueWithCleanRun();
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync, {
    latestRev: async () => "rev-2",
    list: async () => {
      throw new Error("page failed");
    },
  });
  expect(sync.mock.calls[0]![0].check).toEqual({ state: "due", rev: "rev-2" });
});
it("runs a connection upgraded with a revision and no listing digest", async () => {
  await dueWithCleanRun();
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionListingDigest: null });
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync, {
    latestRev: async () => "rev-2",
    list: async () => listed(),
  });
  expect(sync).toHaveBeenCalledTimes(1);
});
it("does not store a moved revision over a request made while the check read the listing", async () => {
  await dueWithCleanRun();
  const requestedAt = new Date();
  await runJobs(vi.fn(), {
    background: true,
    latestRev: async () => "rev-2",
    list: async () => {
      await fixture.database.update(atprotoConnections).set({
        subscriptionNextAttemptAt: requestedAt,
        subscriptionRepoRev: null,
      });
      return listed();
    },
  });
  expect(await connection()).toMatchObject({
    subscriptionNextAttemptAt: requestedAt,
    subscriptionRepoRev: null,
  });
});
it("runs a cleared revision in full without asking the PDS first", async () => {
  await save();
  const latestRev = vi.fn(async () => "rev-1");
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync, { latestRev });
  expect(latestRev).not.toHaveBeenCalled();
  expect(sync.mock.calls[0]![0].check).toEqual({ state: "due" });
});
it("rechecks every 15 minutes only when the background owns the account's refresh", async () => {
  await save();
  const started = Date.now();
  await runJobs(async () => completed(), { background: true });
  const next = (await connection()).subscriptionNextAttemptAt!.getTime();
  expect(next).toBeGreaterThanOrEqual(started + 15 * 60_000);
  expect(next).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  await save();
  await runJobs(async () => completed());
  expect((await connection()).subscriptionNextAttemptAt).toBeNull();
});
it("keeps a retry that falls before the next recurring check", async () => {
  await save();
  const retryAt = new Date(Date.now() + 60_000);
  await runJobs(async () => ({ ...completed(), retryAt }), {
    background: true,
  });
  expect((await connection()).subscriptionNextAttemptAt).toEqual(retryAt);
});
it("does not overwrite a request made while an idle check was reading the PDS", async () => {
  await dueWithCleanRun();
  const requestedAt = new Date();
  await runJobs(vi.fn(), {
    background: true,
    latestRev: async () => {
      await fixture.database.update(atprotoConnections).set({
        subscriptionNextAttemptAt: requestedAt,
        subscriptionRepoRev: null,
      });
      return "rev-1";
    },
  });
  expect(await connection()).toMatchObject({
    subscriptionNextAttemptAt: requestedAt,
    subscriptionRepoRev: null,
  });
});
it("clears the schedule of a due connection that no longer syncs, without running", async () => {
  await dueWithCleanRun();
  await fixture.database
    .update(atprotoConnections)
    .set({ status: "disconnected" });
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  await runJobs(sync, { background: true });
  expect(sync).not.toHaveBeenCalled();
  expect((await connection()).subscriptionNextAttemptAt).toBeNull();
});
it("reports pending only for a request the user started and has not seen finish", async () => {
  const status = async () =>
    (await getPublicationSyncJob(fixture.database, "owner"))?.pending;
  const set = (values: Partial<typeof atprotoConnections.$inferInsert>) =>
    fixture.database.update(atprotoConnections).set(values);
  await save();
  expect(await status()).toBe(true);
  // A request still waiting for its first result is watched, however long.
  await set({ subscriptionNextAttemptAt: new Date(Date.now() + 60_000) });
  expect(await status()).toBe(true);
  // A settled request has its result. A due recurring check or retry, and a
  // retry scheduled further out, give the interface nothing to watch.
  await set({
    subscriptionNextAttemptAt: new Date(0),
    subscriptionJobResult: { ...completed(), status: "partial", deferred: 2 },
  });
  expect(await status()).toBe(false);
  await set({ subscriptionNextAttemptAt: new Date(Date.now() + 86_400_000) });
  expect(await status()).toBe(false);
  // Nor does a background run that holds the lease.
  await set({
    subscriptionNextAttemptAt: new Date(Date.now() + 15 * 60_000),
    subscriptionJobExpiresAt: new Date(Date.now() + 60_000),
  });
  expect(await status()).toBe(false);
  // A continuation keeps the request's progress, and so its place in view.
  await set({
    subscriptionNextAttemptAt: new Date(Date.now() + 1000),
    subscriptionJobExpiresAt: null,
    subscriptionJobProgress: { completed: 1, total: 3 },
  });
  expect(await status()).toBe(true);
});
it("stops reporting pending when sync is turned off while an earlier worker holds its lease", async () => {
  await save();
  await fixture.database.update(atprotoConnections).set({
    subscriptionJobToken: "earlier-worker",
    subscriptionJobExpiresAt: new Date(Date.now() + 300_000),
  });
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: true,
    running: true,
  });
  await save("none");
  // Nothing is scheduled for the new request; the lease belongs to the old one.
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    running: true,
    result: null,
  });
});
it("keeps a request made during a run and still records the run's result", async () => {
  await save();
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) });
  const requestedAt = new Date();
  const continued = await runJobs(
    async () => {
      // The user adds or deletes a publication Feed while the run is in flight.
      await fixture.database.update(atprotoConnections).set({
        subscriptionNextAttemptAt: requestedAt,
        subscriptionRepoRev: null,
      });
      return completed();
    },
    { background: true },
  );
  expect(continued).toBe(true);
  expect(await connection()).toMatchObject({
    subscriptionNextAttemptAt: requestedAt,
    subscriptionRepoRev: null,
    subscriptionJobToken: null,
    subscriptionJobResult: { exported: 1 },
  });
});
it("schedules a missing check only for a connection that syncs and has none", async () => {
  const schedule = () => scheduleMissingSyncCheck(fixture.database, "owner");
  // Sync is off: nothing to schedule.
  await schedule();
  expect((await connection()).subscriptionNextAttemptAt).toBeNull();
  await save();
  await runJobs(async () => completed());
  expect((await connection()).subscriptionNextAttemptAt).toBeNull();
  const before = await connection();
  await schedule();
  const scheduled = await connection();
  expect(scheduled.subscriptionNextAttemptAt).toBeInstanceOf(Date);
  expect(scheduled).toEqual({
    ...before,
    subscriptionNextAttemptAt: scheduled.subscriptionNextAttemptAt,
  });
  // An existing schedule stands.
  const later = new Date(Date.now() + 600_000);
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: later });
  await schedule();
  expect((await connection()).subscriptionNextAttemptAt).toEqual(later);
});
it("runs when backfill has work, and waits for a backfill retry that is not due", async () => {
  await dueWithCleanRun();
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionBackfillStarted: false });
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync, { latestRev: async () => "rev-1" });
  expect(sync).toHaveBeenCalledTimes(1);
  const backfillRetry = new Date(Date.now() + 120_000);
  await fixture.database.update(atprotoConnections).set({
    subscriptionBackfillStarted: true,
    subscriptionBackfillNextAttemptAt: backfillRetry,
    subscriptionRepoRev: "rev-1",
    subscriptionNextAttemptAt: new Date(0),
  });
  await runJobs(sync, { background: true, latestRev: async () => "rev-1" });
  expect(sync).toHaveBeenCalledTimes(1);
  expect((await connection()).subscriptionNextAttemptAt).toEqual(backfillRetry);
});
it("stays idle while an import retry waits, with one write, and runs once it is due", async () => {
  await dueWithCleanRun();
  const importRetry = new Date(Date.now() + 86_400_000);
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionRetryAt: importRetry });
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  const update = vi.spyOn(fixture.database, "update");
  // The account's refresh is client-owned, so the retry is all that is scheduled.
  await runJobs(sync, { latestRev: async () => "rev-1" });
  expect(sync).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledTimes(1);
  expect(await connection()).toMatchObject({
    subscriptionNextAttemptAt: importRetry,
    subscriptionRepoRev: "rev-1",
    subscriptionJobToken: null,
  });
  // A recurring check falls before the retry and stays idle too.
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) });
  await runJobs(sync, { background: true, latestRev: async () => "rev-1" });
  expect(sync).not.toHaveBeenCalled();
  expect(
    (await connection()).subscriptionNextAttemptAt!.getTime(),
  ).toBeLessThan(importRetry.getTime());
  // Once the retry is due the run happens, without asking the PDS first.
  await fixture.database.update(atprotoConnections).set({
    subscriptionRetryAt: new Date(0),
    subscriptionNextAttemptAt: new Date(0),
  });
  const latestRev = vi.fn(async () => "rev-1");
  await runJobs(sync, { latestRev });
  expect(latestRev).not.toHaveBeenCalled();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]![0].check).toEqual({ state: "due" });
});
it("ends a request the user started when a check finds nothing left to do", async () => {
  await save();
  // An inline run finished the work before the queued one started.
  await fixture.database.update(atprotoConnections).set({
    subscriptionRepoRev: "rev-1",
    subscriptionBackfillStarted: true,
  });
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  await runJobs(sync, { latestRev: async () => "rev-1" });
  expect(sync).not.toHaveBeenCalled();
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    progress: null,
    result: { status: "completed", exported: 0 },
  });
  expect(announce).toHaveBeenCalledExactlyOnceWith("owner");
});

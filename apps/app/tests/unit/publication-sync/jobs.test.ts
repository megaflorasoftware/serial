import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { syncPublicationSubscriptions } from "~/server/publication-sync/engine";
import { atprotoConnections, user } from "~/server/db/schema";
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
/** Jobs for an account whose refresh the client owns, unless a test says otherwise. */
const runJobs = (
  sync: typeof syncPublicationSubscriptions,
  options: {
    background?: boolean;
    latestRev?: () => Promise<string | null>;
  } = {},
) =>
  runPublicationSyncJobs(fixture.database, sync, {
    refreshesInBackground: async () => options.background ?? false,
    latestRev: options.latestRev,
  });
const connection = async () =>
  (await fixture.database
    .select()
    .from(atprotoConnections)
    .where(eq(atprotoConnections.id, "connection"))
    .get())!;
/** A connection whose last run and backfill finished cleanly against `rev`, due for a check. */
const dueWithCleanRun = async (rev = "rev-1") => {
  await save();
  await runJobs(async () => completed());
  await fixture.database
    .update(atprotoConnections)
    .set({
      subscriptionRepoRev: rev,
      subscriptionBackfillStarted: true,
      subscriptionNextAttemptAt: new Date(0),
    })
    .where(eq(atprotoConnections.id, "connection"));
  return connection();
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
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    running: false,
    progress: { completed: 1, total: 1 },
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
it("persists backfill continuation with accumulated successful writes", async () => {
  await save();
  await runJobs(async () => ({
    ...completed(),
    retryAt: new Date(Date.now() + 60_000),
  }));
  // A retry scheduled further out keeps its result and stops the interface polling.
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    running: false,
    result: { exported: 1 },
  });
  expect((await connection()).subscriptionNextAttemptAt).toBeInstanceOf(Date);
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) })
    .where(eq(atprotoConnections.id, "connection"));
  await runJobs(async () => completed());
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { exported: 2 },
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
it("runs when the repository revision changed, handing the engine what it read", async () => {
  await dueWithCleanRun();
  const sync = vi
    .fn<typeof syncPublicationSubscriptions>()
    .mockResolvedValue(completed());
  await runJobs(sync, { latestRev: async () => "rev-2" });
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]![0].check).toEqual({ state: "due", rev: "rev-2" });
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
it("reports pending only for a run in flight or a request about to start", async () => {
  const status = async () =>
    (await getPublicationSyncJob(fixture.database, "owner"))?.pending;
  const set = (values: Partial<typeof atprotoConnections.$inferInsert>) =>
    fixture.database.update(atprotoConnections).set(values);
  await save();
  expect(await status()).toBe(true);
  // A new request scheduled further out is not worth polling for yet.
  await set({ subscriptionNextAttemptAt: new Date(Date.now() + 60_000) });
  expect(await status()).toBe(false);
  // A due recurring check or retry already has its result.
  await set({
    subscriptionNextAttemptAt: new Date(0),
    subscriptionJobResult: completed(),
  });
  expect(await status()).toBe(false);
  await set({
    subscriptionNextAttemptAt: new Date(Date.now() + 15 * 60_000),
    subscriptionJobExpiresAt: new Date(Date.now() + 60_000),
  });
  expect(await status()).toBe(true);
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

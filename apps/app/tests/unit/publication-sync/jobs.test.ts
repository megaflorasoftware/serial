import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { syncPublicationSubscriptions } from "~/server/publication-sync/engine";
import { atprotoConnections, user } from "~/server/db/schema";
import { persistAtprotoSyncSettings } from "~/server/auth/atproto/sync-settings";
import {
  getPublicationSyncJob,
  runPublicationSyncJobs,
} from "~/server/publication-sync/jobs";
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
    result: null,
  });
  const sync = vi.fn<typeof syncPublicationSubscriptions>(
    async ({ onProgress, runId }) => {
      await onProgress?.({ runId: runId!, completed: 1, total: 1 });
      return completed();
    },
  );
  await runPublicationSyncJobs(fixture.database, sync);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
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
  await runPublicationSyncJobs(fixture.database, sync);
  expect(sync).not.toHaveBeenCalled();
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionJobExpiresAt: new Date(0) });
  await runPublicationSyncJobs(fixture.database, sync);
  expect(sync).toHaveBeenCalledTimes(1);
});
it("keeps a later save when an older worker finishes", async () => {
  await save();
  const first = await getPublicationSyncJob(fixture.database, "owner");
  await runPublicationSyncJobs(fixture.database, async () => {
    await save();
    return completed();
  });
  const newer = await getPublicationSyncJob(fixture.database, "owner");
  expect(newer?.runId).not.toBe(first?.runId);
  expect(newer).toMatchObject({ pending: true, result: null });
  await runPublicationSyncJobs(fixture.database, async () => completed());
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { exported: 1 },
  });
});
it("persists backfill continuation with accumulated successful writes", async () => {
  await save();
  await runPublicationSyncJobs(fixture.database, async () => ({
    ...completed(),
    retryAt: new Date(Date.now() + 60_000),
  }));
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: true,
    result: { exported: 1 },
  });
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(0) })
    .where(eq(atprotoConnections.id, "connection"));
  await runPublicationSyncJobs(fixture.database, async () => completed());
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
    result: { exported: 2 },
  });
});
it("turning sync off cancels queued work", async () => {
  await save();
  await save("none");
  const sync = vi.fn<typeof syncPublicationSubscriptions>();
  await runPublicationSyncJobs(fixture.database, sync);
  expect(sync).not.toHaveBeenCalled();
  expect(await getPublicationSyncJob(fixture.database, "owner")).toMatchObject({
    pending: false,
  });
});

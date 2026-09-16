import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { nextPublicationSyncAttempt } from "./requests";
import type { syncPublicationSubscriptions } from "./engine";
import type { db } from "~/server/db";
import type {
  PublicationSyncJobStatus,
  PublicationSyncResult,
} from "~/lib/auth/publication-sync";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";
import { atprotoConnections as connections } from "~/server/db/schema";
import { workerPool } from "~/lib/workerPool";
import { logError } from "~/server/logger";

const JOB_LEASE_MS = 300_000;
const JOB_PAGE_SIZE = 4;
const JOB_CONCURRENCY = 2;

export async function getPublicationSyncJob(
  database: typeof db,
  userId: string,
): Promise<PublicationSyncJobStatus | null> {
  const row = await database
    .select({
      runId: connections.subscriptionRequestId,
      next: connections.subscriptionNextAttemptAt,
      progress: connections.subscriptionJobProgress,
      result: connections.subscriptionJobResult,
    })
    .from(connections)
    .where(eq(connections.userId, userId))
    .get();
  return row?.runId
    ? {
        runId: row.runId,
        pending: row.next !== null,
        progress: row.progress,
        result: row.result,
      }
    : null;
}

/** A database claim owns execution. Browser lifetimes and local process locks do not. */
export async function runPublicationSyncJobs(
  database: typeof db,
  sync: typeof syncPublicationSubscriptions = async (input) => {
    const { syncPublicationSubscriptions } = await import("./engine");
    return syncPublicationSubscriptions(input);
  },
) {
  const now = new Date();
  const available = and(
    lte(connections.subscriptionNextAttemptAt, now),
    or(
      isNull(connections.subscriptionJobExpiresAt),
      lt(connections.subscriptionJobExpiresAt, now),
    ),
  );
  const rows = await database
    .select({ id: connections.id })
    .from(connections)
    .where(available)
    .orderBy(asc(connections.subscriptionNextAttemptAt))
    .limit(JOB_PAGE_SIZE);
  let continued = false;
  for await (const again of workerPool(
    rows,
    JOB_CONCURRENCY,
    async ({ id }) => {
      const token = randomUUID();
      const [job] = await database
        .update(connections)
        .set({
          subscriptionJobToken: token,
          subscriptionJobExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
        })
        .where(and(eq(connections.id, id), available))
        .returning();
      if (!job) return false;
      const claim = and(
        eq(connections.id, id),
        eq(connections.subscriptionJobToken, token),
        eq(connections.subscriptionRequestId, job.subscriptionRequestId!),
      );
      let result: PublicationSyncResult;
      try {
        result = job.userId
          ? await sync({
              database,
              userId: job.userId,
              runId: job.subscriptionRequestId!,
              onProgress: async (progress) => {
                await database
                  .update(connections)
                  .set({
                    subscriptionJobProgress: {
                      completed: progress.completed,
                      total: progress.total,
                    },
                  })
                  .where(claim);
              },
            })
          : { ...emptyPublicationSyncCounts(), status: "skipped" };
      } catch (error) {
        logError("[publication-sync] queued sync failed", error);
        result = {
          ...emptyPublicationSyncCounts(),
          status: "partial",
          failed: 1,
        };
      }
      const next = nextPublicationSyncAttempt(result);
      const previous = job.subscriptionJobResult;
      const accumulated = { ...result };
      for (const key of [
        "imported",
        "exported",
        "inactive",
        "removed",
      ] as const)
        accumulated[key] += previous?.[key] ?? 0;
      try {
        await database
          .update(connections)
          .set({
            subscriptionJobResult: accumulated,
            subscriptionNextAttemptAt: next,
          })
          .where(claim);
      } finally {
        // A later settings save keeps its request, but the old worker releases its lease.
        await database
          .update(connections)
          .set({ subscriptionJobToken: null, subscriptionJobExpiresAt: null })
          .where(
            and(
              eq(connections.id, id),
              eq(connections.subscriptionJobToken, token),
            ),
          );
      }
      return next !== null && next.getTime() <= Date.now() + 1000;
    },
  ))
    continued ||= again;
  return continued || rows.length === JOB_PAGE_SIZE;
}

const running = new WeakSet<typeof db>();
/** Best-effort immediate wakeup; the scheduled task recovers persisted work after restart. */
export function wakePublicationSyncJobs(database: typeof db) {
  if (running.has(database)) return;
  running.add(database);
  void runPublicationSyncJobs(database)
    .then((continued) => {
      if (continued)
        setTimeout(() => wakePublicationSyncJobs(database), 1100).unref();
    })
    .catch((error: unknown) =>
      logError("[publication-sync] worker failed", error),
    )
    .finally(() => running.delete(database));
}

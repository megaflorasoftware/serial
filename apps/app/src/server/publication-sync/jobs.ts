import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import { checkPublicationSync, syncCheckColumns } from "./check";
import { nextPublicationSyncAttempt } from "./requests";
import type { LatestRev, SyncCheckRow } from "./check";
import type { syncPublicationSubscriptions } from "./engine";
import type { db } from "~/server/db";
import type {
  PublicationSyncJobStatus,
  PublicationSyncResult,
} from "~/lib/auth/publication-sync";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";
import { atprotoConnections as connections, user } from "~/server/db/schema";
import { automaticRssOwnerForAccount } from "~/server/rss/automaticOwnership";
import { workerPool } from "~/lib/workerPool";
import { logError } from "~/server/logger";

const JOB_LEASE_MS = 300_000;
const JOB_PAGE_SIZE = 4;
const JOB_CONCURRENCY = 2;
/**
 * How often a connection whose refresh runs in the background asks its PDS
 * whether subscriptions changed in another app. Local changes do not wait for
 * it; they request a run themselves.
 */
export const REMOTE_CHANGE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** How soon a request must be due for the interface to keep watching for it. */
const PENDING_WINDOW_MS = 5_000;

export async function getPublicationSyncJob(
  database: typeof db,
  userId: string,
): Promise<PublicationSyncJobStatus | null> {
  const row = await database
    .select({
      runId: connections.subscriptionRequestId,
      next: connections.subscriptionNextAttemptAt,
      leaseExpires: connections.subscriptionJobExpiresAt,
      progress: connections.subscriptionJobProgress,
      result: connections.subscriptionJobResult,
    })
    .from(connections)
    .where(eq(connections.userId, userId))
    .get();
  if (!row?.runId) return null;
  const now = Date.now();
  const running = row.leaseExpires !== null && row.leaseExpires.getTime() > now;
  // A request with no result yet is about to start. A recurring check or a
  // retry scheduled further out already has its result and is not worth polling.
  const starting =
    row.result === null &&
    row.next !== null &&
    row.next.getTime() <= now + PENDING_WINDOW_MS;
  return {
    runId: row.runId,
    pending: running || starting,
    running,
    progress: row.progress,
    result: row.result,
  };
}

type Account = { id: string; role: string | null };
type JobDependencies = {
  latestRev?: LatestRev;
  /** Whether the account's Feed refresh, and so its recurring check, runs in the background. */
  refreshesInBackground?: (account: Account) => Promise<boolean>;
};
type DueJob = SyncCheckRow & { scheduledAt: Date | null; role: string | null };

async function refreshesInBackground(account: Account) {
  return (await automaticRssOwnerForAccount(account)) === "background-task";
}

function earliest(...times: Array<Date | null | undefined>) {
  const known = times.flatMap((time) => (time ? [time.getTime()] : []));
  return known.length ? new Date(Math.min(...known)) : null;
}

/** A database claim owns execution. Browser lifetimes and local process locks do not. */
export async function runPublicationSyncJobs(
  database: typeof db,
  sync: typeof syncPublicationSubscriptions = async (input) => {
    const { syncPublicationSubscriptions } = await import("./engine");
    return syncPublicationSubscriptions(input);
  },
  dependencies: JobDependencies = {},
) {
  const now = new Date();
  const unclaimed = or(
    isNull(connections.subscriptionJobExpiresAt),
    lt(connections.subscriptionJobExpiresAt, now),
  );
  const available = and(
    lte(connections.subscriptionNextAttemptAt, now),
    unclaimed,
  );
  const rows: DueJob[] = await database
    .select({
      ...syncCheckColumns,
      scheduledAt: connections.subscriptionNextAttemptAt,
      role: user.role,
    })
    .from(connections)
    .leftJoin(user, eq(user.id, connections.userId))
    .where(available)
    .orderBy(asc(connections.subscriptionNextAttemptAt))
    .limit(JOB_PAGE_SIZE);
  const nextRemoteChangeCheck = async (job: DueJob) =>
    job.userId &&
    (await (dependencies.refreshesInBackground ?? refreshesInBackground)({
      id: job.userId,
      role: job.role,
    }))
      ? new Date(Date.now() + REMOTE_CHANGE_CHECK_INTERVAL_MS)
      : null;
  /** A check that found nothing to do costs this one guarded write and no claim. */
  const rescheduleUnclaimed = (job: DueJob, next: Date | null) =>
    database
      .update(connections)
      .set({ subscriptionNextAttemptAt: next })
      .where(
        and(
          eq(connections.id, job.id),
          // A request made since the read moves the schedule and clears the revision.
          eq(connections.subscriptionNextAttemptAt, job.scheduledAt!),
          job.subscriptionRepoRev === null
            ? isNull(connections.subscriptionRepoRev)
            : eq(connections.subscriptionRepoRev, job.subscriptionRepoRev),
          unclaimed,
        ),
      );
  let continued = false;
  for await (const again of workerPool(rows, JOB_CONCURRENCY, async (row) => {
    // A check that cannot decide must not hold up the rest of the page.
    const check = await checkPublicationSync(row, dependencies.latestRev).catch(
      (error: unknown) => {
        logError("[publication-sync] check failed", error);
        return { state: "due" } as const;
      },
    );
    if (check.state === "disabled") {
      await rescheduleUnclaimed(row, null);
      return false;
    }
    if (check.state === "current") {
      await rescheduleUnclaimed(
        row,
        earliest(await nextRemoteChangeCheck(row), check.backfillRetryAt),
      );
      return false;
    }
    const { id } = row;
    const token = randomUUID();
    const [job] = await database
      .update(connections)
      .set({
        subscriptionJobToken: token,
        subscriptionJobExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
        subscriptionJobProgress: null,
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
            check,
            onProgress: async (progress) => {
              await database
                .update(connections)
                .set({
                  subscriptionJobExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
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
    const next = earliest(
      nextPublicationSyncAttempt(result),
      result.status === "skipped" ? null : await nextRemoteChangeCheck(row),
    );
    const previous = job.subscriptionJobResult;
    const accumulated = { ...result };
    for (const key of ["imported", "exported", "inactive", "removed"] as const)
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
  }))
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

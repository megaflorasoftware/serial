import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { checkPublicationSync, syncCheckColumns } from "./check";
import { nextPublicationSyncAttempt } from "./requests";
import { scheduleUnchangedSince } from "./state";
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
  const due =
    row.next !== null && row.next.getTime() <= now + PENDING_WINDOW_MS;
  // A request is unfinished until it has a result, and again while that result
  // reports deferred work for a continuation to pick up. A recurring check or
  // a retry scheduled further out already has its result.
  const unfinished = row.result === null || row.result.deferred > 0;
  return {
    runId: row.runId,
    // A lease with nothing scheduled belongs to a request the user has since
    // replaced, such as turning sync off while a worker was still running.
    pending: (running && row.next !== null) || (due && unfinished),
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

/** `next`, unless a request made during the run has already moved the schedule. */
function scheduleUnlessRequested(claimedAt: Date | null, next: Date | null) {
  return sql<Date | null>`case when ${scheduleUnchangedSince(claimedAt)} then ${next === null ? null : next.getTime()} else ${connections.subscriptionNextAttemptAt} end`;
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
          scheduleUnchangedSince(job.scheduledAt),
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
    let scheduled = next;
    try {
      // The result always lands; the schedule only when no Feed changed mid-run.
      const [finished] = await database
        .update(connections)
        .set({
          subscriptionJobResult: accumulated,
          subscriptionNextAttemptAt: scheduleUnlessRequested(
            job.subscriptionNextAttemptAt,
            next,
          ),
        })
        .where(claim)
        .returning({ next: connections.subscriptionNextAttemptAt });
      if (finished) scheduled = finished.next;
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
    return scheduled !== null && scheduled.getTime() <= Date.now() + 1000;
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

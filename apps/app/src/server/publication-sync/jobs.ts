import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { checkPublicationSync, earliest, syncCheckColumns } from "./check";
import { nextPublicationSyncAttempt } from "./requests";
import { scheduleUnchangedSince } from "./state";
import { throttleWithTrailing } from "./throttle";
import type { SubscriptionRemote, SyncCheckRow } from "./check";
import type { syncPublicationSubscriptions } from "./engine";
import type { db } from "~/server/db";
import type {
  PublicationSyncJobStatus,
  PublicationSyncResult,
} from "~/lib/auth/publication-sync";
import type { TwoStageProgress } from "~/lib/two-stage-progress";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";
import { findingProgress } from "~/lib/two-stage-progress";
import { withIdentityCache } from "~/server/auth/atproto/did-resolver";
import { atprotoConnections as connections, user } from "~/server/db/schema";
import { automaticRssOwnerForAccount } from "~/server/rss/automaticOwnership";
import { workerPool } from "~/lib/workerPool";
import { logError } from "~/server/logger";
import { createInProcessWake } from "~/server/inProcessWake";

const JOB_LEASE_MS = 300_000;
const JOB_PAGE_SIZE = 4;
const JOB_CONCURRENCY = 2;
/**
 * How often a connection whose refresh runs in the background asks its PDS
 * whether subscriptions changed in another app. Local changes do not wait for
 * it; they request a run themselves.
 */
export const REMOTE_CHANGE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** How soon a follow-up run must be due to count as the same piece of work. */
const CONTINUATION_WINDOW_MS = 1000;
/**
 * The least time between two progress announcements of one run. A change
 * inside it is announced once the interval ends.
 */
const PROGRESS_ANNOUNCEMENT_INTERVAL_MS = 1000;

type JobState = {
  progress: TwoStageProgress | null;
  result: PublicationSyncResult | null;
};

/**
 * A request the user started, by saving settings or returning from consent,
 * stays in flight until a run for it finishes with no immediate continuation.
 * It has no result yet, or keeps its progress while a continuation is due.
 * Every later run is background work: a recurring check, a retry, or a Feed
 * the user added or deleted. Those write no job state and go unannounced.
 */
function requestInFlight(job: JobState) {
  return job.result === null || job.progress !== null;
}

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
  return {
    runId: row.runId,
    // The interface watches only a request the user started, and only while
    // something is scheduled for it. Turning sync off leaves nothing
    // scheduled, whatever lease an earlier run still holds.
    pending: requestInFlight(row) && row.next !== null,
    running:
      row.leaseExpires !== null && row.leaseExpires.getTime() > Date.now(),
    progress: row.progress,
    result: row.result,
  };
}

type Account = { id: string; role: string | null };
type JobDependencies = {
  /** What a check asks the PDS. */
  remote?: SubscriptionRemote;
  /** Whether the account's Feed refresh, and so its recurring check, runs in the background. */
  refreshesInBackground?: (account: Account) => Promise<boolean>;
  /** Tells the user's open clients that the persisted status changed. */
  announce?: (userId: string) => Promise<void>;
};
type DueJob = SyncCheckRow &
  JobState & { scheduledAt: Date | null; role: string | null };

async function refreshesInBackground(account: Account) {
  return (await automaticRssOwnerForAccount(account)) === "background-task";
}

async function announceSyncStatus(userId: string) {
  const { announceSyncStatus: announce } = await import("./announce");
  await announce(userId);
}

/** `next`, unless a request made during the run has already moved the schedule. */
function scheduleUnlessRequested(claimedAt: Date | null, next: Date | null) {
  return sql<Date | null>`case when ${scheduleUnchangedSince(claimedAt)} then ${next === null ? null : next.getTime()} else ${connections.subscriptionNextAttemptAt} end`;
}

/**
 * What a visible run leaves in the progress column. The request keeps its
 * progress, and so stays in flight, while another run is due at once: this
 * run's own continuation, or a request made while it ran.
 */
function progressUnlessSettled(claimedAt: Date | null, continues: boolean) {
  const kept = sql`coalesce(${connections.subscriptionJobProgress}, ${JSON.stringify(findingProgress(0))})`;
  return continues
    ? kept
    : sql`case when ${scheduleUnchangedSince(claimedAt)} then null else ${kept} end`;
}

/** A busy run did nothing and a deferred one resumes at once: neither ends the request. */
function continuesAtOnce(result: PublicationSyncResult, retry: Date | null) {
  return (
    result.status === "busy" ||
    (retry !== null && retry.getTime() <= Date.now() + CONTINUATION_WINDOW_MS)
  );
}

/**
 * The request's count once a run reports its own. A run that continues a
 * request picks up where the last one left off, and the count never moves
 * back to an earlier stage. Each finding pass goes over every publication
 * again, so its count stops at the total. Fetching sees only the Feeds that
 * still wait, so the ones earlier runs fetched stay counted.
 */
function requestProgress(
  previous: TwoStageProgress | null,
  run: TwoStageProgress,
): TwoStageProgress {
  if (!previous?.total) return run;
  if (!run.total || (run.stage === "finding" && previous.stage === "fetching"))
    return previous;
  if (run.stage !== previous.stage) return run;
  return run.stage === "finding"
    ? {
        ...run,
        completed: Math.min(run.total, previous.completed + run.completed),
      }
    : {
        ...run,
        completed: previous.completed + run.completed,
        total: previous.completed + run.total,
      };
}

/**
 * One request's runs report a single total. What each run did adds up. Its
 * failures do not: a run that lists the repository meets every failure again,
 * and one that reads the cached snapshot cannot see an invalid record, so the
 * request keeps the most any of its runs saw. Background runs never add to it.
 */
function accumulatedResult(
  previous: PublicationSyncResult | null,
  result: PublicationSyncResult,
): PublicationSyncResult {
  const accumulated = { ...result };
  for (const key of ["imported", "exported", "inactive", "removed"] as const)
    accumulated[key] += previous?.[key] ?? 0;
  accumulated.failed = Math.max(result.failed, previous?.failed ?? 0);
  // A request that failed somewhere did not complete cleanly, whatever its last run found.
  if (accumulated.failed && accumulated.status === "completed")
    accumulated.status = "partial";
  return accumulated;
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
      progress: connections.subscriptionJobProgress,
      result: connections.subscriptionJobResult,
      role: user.role,
    })
    .from(connections)
    .leftJoin(user, eq(user.id, connections.userId))
    .where(available)
    .orderBy(asc(connections.subscriptionNextAttemptAt))
    .limit(JOB_PAGE_SIZE);
  const announce = dependencies.announce ?? announceSyncStatus;
  const nextRemoteChangeCheck = async (job: DueJob) =>
    job.userId &&
    (await (dependencies.refreshesInBackground ?? refreshesInBackground)({
      id: job.userId,
      role: job.role,
    }))
      ? new Date(Date.now() + REMOTE_CHANGE_CHECK_INTERVAL_MS)
      : null;
  /**
   * A check that found nothing to do costs this one guarded write and no
   * claim. A request the user started ends here too, with `outcome` to show.
   * `rev` is a newer revision whose listing the last run already saw.
   */
  const settleUnclaimed = async (
    job: DueJob,
    next: Date | null,
    outcome: PublicationSyncResult["status"],
    rev?: string,
  ) => {
    const visible = requestInFlight(job);
    const settled = await database
      .update(connections)
      .set({
        subscriptionNextAttemptAt: next,
        ...(rev === undefined ? {} : { subscriptionRepoRev: rev }),
        ...(visible
          ? {
              subscriptionJobResult: accumulatedResult(job.result, {
                ...emptyPublicationSyncCounts(),
                status: outcome,
              }),
              subscriptionJobProgress: null,
            }
          : {}),
      })
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
    if (visible && job.userId && settled.rowsAffected > 0)
      await announce(job.userId);
  };
  let continued = false;
  // One connection's check and run share their identity lookups.
  const runJob = (row: DueJob) => withIdentityCache(() => runDueJob(row));
  const runDueJob = async (row: DueJob) => {
    // A check that cannot decide must not hold up the rest of the page.
    const check = await checkPublicationSync(row, dependencies.remote).catch(
      (error: unknown) => {
        logError("[publication-sync] check failed", error);
        return { state: "due" } as const;
      },
    );
    if (check.state === "disabled") {
      await settleUnclaimed(row, null, "skipped");
      return false;
    }
    if (check.state === "current") {
      await settleUnclaimed(
        row,
        earliest(await nextRemoteChangeCheck(row), check.retryAt),
        "completed",
        check.rev,
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
      })
      .where(and(eq(connections.id, id), available))
      .returning();
    if (!job) return false;
    const claim = and(
      eq(connections.id, id),
      eq(connections.subscriptionJobToken, token),
      job.subscriptionRequestId === null
        ? isNull(connections.subscriptionRequestId)
        : eq(connections.subscriptionRequestId, job.subscriptionRequestId),
    );
    // Only a run for a request the user started shows its work.
    const visible = requestInFlight({
      progress: job.subscriptionJobProgress,
      result: job.subscriptionJobResult,
    });
    const announceChange = async () => {
      if (visible && job.userId) await announce(job.userId);
    };
    const progressAnnouncement = throttleWithTrailing(
      announceChange,
      PROGRESS_ANNOUNCEMENT_INTERVAL_MS,
      (error) =>
        logError("[publication-sync] progress announcement failed", error),
    );
    let result: PublicationSyncResult;
    try {
      result = job.userId
        ? await sync({
            database,
            userId: job.userId,
            runId: job.subscriptionRequestId ?? token,
            check,
            onProgress: async ({ stage, completed, total }) => {
              await database
                .update(connections)
                .set({
                  subscriptionJobExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
                  ...(visible
                    ? {
                        subscriptionJobProgress: requestProgress(
                          job.subscriptionJobProgress,
                          { stage, completed, total },
                        ),
                      }
                    : {}),
                })
                .where(claim);
              await progressAnnouncement.request();
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
    const retry = nextPublicationSyncAttempt(result);
    const next = earliest(
      retry,
      result.status === "skipped" ? null : await nextRemoteChangeCheck(row),
    );
    const continues = continuesAtOnce(result, retry);
    let scheduled = next;
    try {
      // The schedule lands only when no Feed changed mid-run. A visible run
      // also records what it did, and gives up its progress once it settles.
      const [finished] = await database
        .update(connections)
        .set({
          ...(visible && result.status !== "busy"
            ? {
                subscriptionJobResult: accumulatedResult(
                  job.subscriptionJobResult,
                  result,
                ),
                subscriptionJobProgress: progressUnlessSettled(
                  job.subscriptionNextAttemptAt,
                  continues,
                ),
              }
            : {}),
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
      // The settled state is announced now; a trailing progress one would repeat it.
      progressAnnouncement.cancel();
      await announceChange();
    }
    return (
      scheduled !== null &&
      scheduled.getTime() <= Date.now() + CONTINUATION_WINDOW_MS
    );
  };
  for await (const again of workerPool(rows, JOB_CONCURRENCY, runJob))
    continued ||= again;
  return continued || rows.length === JOB_PAGE_SIZE;
}

/** Best-effort immediate wakeup; the scheduled task recovers persisted work after restart. */
export const wakePublicationSyncJobs = createInProcessWake(
  "publication-sync",
  (database: typeof db) => runPublicationSyncJobs(database),
);

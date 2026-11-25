import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { backfillPublicationOrigin } from "./backfill";
import type { db } from "~/server/db";
import type { CaptureLease } from "~/server/bookmarks/limits";
import { captureLimiter } from "~/server/bookmarks/limits";
import { feedOriginChecks as checks } from "~/server/db/schema";
import { publicationIsGone } from "~/server/feeds/importErrors";
import { revalidateFeed } from "~/server/feeds/revalidate";
import { nextRetryAt } from "~/server/publication-sync/retry";
import { throttleWithTrailing } from "~/server/publication-sync/throttle";
import {
  organizationInvalidationSummary,
  publishReconciliationInvalidation,
} from "~/server/reconciliation/invalidation";
import { workerPool } from "~/lib/workerPool";
import { logError } from "~/server/logger";
import { createInProcessWake } from "~/server/inProcessWake";

/** How far a claim moves a row's next attempt. A row whose run stopped is due again after it. */
const CLAIM_MS = 5 * 60_000;
export const CHECKS_PER_USER = 2;
const USER_PAGE_SIZE = 8;
const USERS_AT_ONCE = 4;
/** The least time between two Feed list updates a user's checks publish. */
const PUBLISH_INTERVAL_MS = 3_000;

type Claim = typeof checks.$inferSelect;
type Dependencies = {
  /** Publication backfill. Resolves to whether an origin joined the Feed. */
  backfill?: (
    database: typeof db,
    userId: string,
    feedId: number,
  ) => Promise<boolean>;
  /** Feed revalidation. Resolves to whether it changed the Feed. */
  revalidate?: (
    database: typeof db,
    userId: string,
    feedId: number,
  ) => Promise<{ changed: boolean }>;
  acquireDiscovery?: (userId: string) => CaptureLease;
  /** Tells the user's open clients that their Feeds changed. */
  publish?: (userId: string) => Promise<void>;
};
/** A check changed the Feed, finished without changing it, or found no discovery slot. */
type Outcome = "changed" | "unchanged" | "waiting";
/** Which checks a worker claims: any, or only backfill once no discovery slot is free. */
type Claimable = "any" | "light";

function publishFeedChanges(userId: string) {
  return publishReconciliationInvalidation(
    userId,
    organizationInvalidationSummary(),
  );
}

/** The row as this worker claimed it. Anyone who changed it since owns it now. */
function held(claim: Claim) {
  return and(
    eq(checks.feedId, claim.feedId),
    eq(checks.nextAttemptAt, claim.nextAttemptAt),
  );
}

async function claimDueCheck(
  database: typeof db,
  userId: string,
  claimable: Claimable,
) {
  const now = new Date();
  const [claim] = await database
    .update(checks)
    .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_MS) })
    .where(
      inArray(
        checks.feedId,
        database
          .select({ feedId: checks.feedId })
          .from(checks)
          .where(
            and(
              eq(checks.userId, userId),
              lte(checks.nextAttemptAt, now),
              claimable === "light" ? eq(checks.type, "light") : undefined,
            ),
          )
          .orderBy(asc(checks.nextAttemptAt))
          .limit(1),
      ),
    )
    .returning();
  return claim;
}

function finish(database: typeof db, claim: Claim) {
  return database.delete(checks).where(held(claim));
}

/** Backfill keeps retrying a failure that may pass, until its backoff runs out. */
async function runBackfill(
  database: typeof db,
  claim: Claim,
  backfill: NonNullable<Dependencies["backfill"]>,
): Promise<Outcome> {
  let retryAt: Date | null = null;
  let attached = false;
  try {
    attached = await backfill(database, claim.userId, claim.feedId);
  } catch (error) {
    logError("[origin-checks] backfill failed", claim.feedId, error);
    // A publication that is gone is a finished check.
    retryAt = publicationIsGone(error) ? null : nextRetryAt(claim.attempts + 1);
  }
  await (retryAt
    ? database
        .update(checks)
        .set({ attempts: claim.attempts + 1, nextAttemptAt: retryAt })
        .where(held(claim))
    : finish(database, claim));
  return attached ? "changed" : "unchanged";
}

/**
 * Revalidation runs discovery, so it takes one of the user's discovery slots.
 * It gets one attempt. Without a free slot it stays due, unattempted.
 */
async function runRevalidation(
  database: typeof db,
  claim: Claim,
  revalidate: NonNullable<Dependencies["revalidate"]>,
  acquireDiscovery: NonNullable<Dependencies["acquireDiscovery"]>,
): Promise<Outcome> {
  const lease = acquireDiscovery(claim.userId);
  if (!lease.ok) {
    await database
      .update(checks)
      .set({ nextAttemptAt: new Date() })
      .where(held(claim));
    return "waiting";
  }
  try {
    const { changed } = await revalidate(database, claim.userId, claim.feedId);
    return changed ? "changed" : "unchanged";
  } catch (error) {
    logError("[origin-checks] revalidation failed", claim.feedId, error);
    return "unchanged";
  } finally {
    lease.release();
    await finish(database, claim);
  }
}

function runCheck(
  database: typeof db,
  claim: Claim,
  dependencies: Dependencies,
) {
  return claim.type === "full"
    ? runRevalidation(
        database,
        claim,
        dependencies.revalidate ?? revalidateFeed,
        dependencies.acquireDiscovery ??
          ((userId) => captureLimiter.acquire(userId, "discovery")),
      )
    : runBackfill(
        database,
        claim,
        dependencies.backfill ?? backfillPublicationOrigin,
      );
}

/**
 * Works through one user's due checks, a few Feeds at a time, until none is
 * due. Their open clients hear of changed Feeds in batches.
 */
async function checkUserFeeds(
  database: typeof db,
  userId: string,
  dependencies: Dependencies,
) {
  let unpublished = false;
  const publish = async () => {
    unpublished = false;
    try {
      await (dependencies.publish ?? publishFeedChanges)(userId);
    } catch (error) {
      logError("[origin-checks] publish failed", error);
    }
  };
  const batched = throttleWithTrailing(publish, PUBLISH_INTERVAL_MS, () => {});
  const checkUntilNothingDue = async () => {
    // Backfill needs no discovery slot, so it carries on once none is free.
    let claimable: Claimable = "any";
    for (;;) {
      // Each claim waits for the previous check, so a user never has more
      // than CHECKS_PER_USER at once.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const claim = await claimDueCheck(database, userId, claimable);
      if (!claim) return;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const outcome = await runCheck(database, claim, dependencies);
      if (outcome === "waiting") claimable = "light";
      if (outcome === "changed") {
        unpublished = true;
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await batched.request();
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: CHECKS_PER_USER }, () =>
        checkUntilNothingDue().catch((error: unknown) =>
          logError("[origin-checks] checks failed", userId, error),
        ),
      ),
    );
  } finally {
    batched.cancel();
    if (unpublished) await publish();
  }
}

/**
 * Runs the due Feed origin checks of a page of users. No Atmosphere connection
 * is needed. Resolves to whether more users may have checks due.
 */
export async function runFeedOriginChecks(
  database: typeof db,
  dependencies: Dependencies = {},
) {
  const due = await database
    .select({ userId: checks.userId })
    .from(checks)
    .where(lte(checks.nextAttemptAt, new Date()))
    .groupBy(checks.userId)
    .limit(USER_PAGE_SIZE);
  for await (const checked of workerPool(due, USERS_AT_ONCE, ({ userId }) =>
    checkUserFeeds(database, userId, dependencies),
  ))
    void checked;
  return due.length === USER_PAGE_SIZE;
}

/**
 * Best-effort immediate start after checks are queued; the per-minute task
 * recovers persisted checks after a restart.
 */
export const wakeFeedOriginChecks = createInProcessWake(
  "origin-checks",
  (database: typeof db) => runFeedOriginChecks(database),
);

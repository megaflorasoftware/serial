import { randomUUID } from "node:crypto";
import { and, eq, exists, inArray, isNull } from "drizzle-orm";
import { syncEnabledFor } from "./state";
import type { PublicationSyncResult } from "~/lib/auth/publication-sync";
import type { FeedDatabase } from "~/server/feeds/origins";
import { atprotoConnections, feedOrigins } from "~/server/db/schema";

/**
 * Clears the revision of the last clean run, so the next run reconciles in
 * full instead of stopping at an unchanged repository.
 */
export const FULL_RECONCILE = { subscriptionRepoRev: null } as const;

export function newPublicationSyncRequest(enabled: boolean) {
  return {
    subscriptionRequestId: randomUUID(),
    subscriptionNextAttemptAt: enabled ? new Date() : null,
    subscriptionJobProgress: null,
    subscriptionJobResult: null,
  };
}

export function nextPublicationSyncAttempt(result: PublicationSyncResult) {
  const retryTimes = [
    ...(result.retryAt ? [new Date(result.retryAt).getTime()] : []),
    ...(result.deferred && !result.retryAt ? [Date.now() + 1000] : []),
    ...(result.status === "busy" ? [Date.now() + 60_000] : []),
  ];
  return retryTimes.length
    ? new Date(Math.max(Date.now() + 1000, Math.min(...retryTimes)))
    : null;
}

/**
 * The user added or deleted these Feeds. When one of them has an Atmosphere
 * origin, sync reconciles now, without a new request for the interface to
 * announce. Call it while the origins exist: after an insert, before a delete.
 */
export async function requestSyncForFeedChange(
  database: FeedDatabase,
  userId: string,
  feedIds: number[],
) {
  if (!feedIds.length) return;
  await database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date(), ...FULL_RECONCILE })
    .where(
      and(
        syncEnabledFor(userId),
        exists(
          database
            .select({ id: feedOrigins.id })
            .from(feedOrigins)
            .where(
              and(
                eq(feedOrigins.userId, userId),
                eq(feedOrigins.kind, "atproto"),
                inArray(feedOrigins.feedId, feedIds),
              ),
            ),
        ),
      ),
    );
}

/** Feeds whose origins include the Atmosphere, when the caller already holds them. */
export function atmosphereFeedIds(
  feeds: Array<{ id: number; origins: Array<{ kind: string }> }>,
) {
  return feeds
    .filter((feed) => feed.origins.some((origin) => origin.kind === "atproto"))
    .map((feed) => feed.id);
}

/**
 * A user whose refresh runs in the background always has a check scheduled,
 * including one who has just moved onto a paid plan. Writes only when sync is
 * on and nothing is scheduled.
 */
export async function scheduleMissingSyncCheck(
  database: FeedDatabase,
  userId: string,
) {
  await database
    .update(atprotoConnections)
    .set({ subscriptionNextAttemptAt: new Date() })
    .where(
      and(
        syncEnabledFor(userId),
        isNull(atprotoConnections.subscriptionNextAttemptAt),
      ),
    );
}

import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { FeedDatabase } from "~/server/feeds/origins";
import { feedOriginChecks, feedOrigins, feeds } from "~/server/db/schema";
import { TEXT_PLATFORMS } from "~/lib/content/descriptor";

/** The user's Feeds matching `where`, as rows due now for a check of `type`. */
function dueChecks(
  database: FeedDatabase,
  userId: string,
  type: "light" | "full",
  where: SQL | undefined,
) {
  return database
    .select({
      feedId: feeds.id,
      userId: feeds.userId,
      type: sql<typeof type>`${type}`.as("type"),
      attempts: sql<number>`0`.as("attempts"),
      nextAttemptAt: sql<number>`${Date.now()}`.as("next_attempt_at"),
    })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), where));
}

/**
 * Queues Publication backfill for the user's text Feeds that have no
 * Atmosphere origin, narrowed by `where`. A Feed already queued keeps its row.
 */
export async function queuePublicationBackfill(
  database: FeedDatabase,
  userId: string,
  where?: SQL,
) {
  await database
    .insert(feedOriginChecks)
    .select(
      dueChecks(
        database,
        userId,
        "light",
        and(
          inArray(feeds.platform, TEXT_PLATFORMS),
          notExists(
            database
              .select({ id: feedOrigins.id })
              .from(feedOrigins)
              .where(
                and(
                  eq(feedOrigins.feedId, feeds.id),
                  eq(feedOrigins.kind, "atproto"),
                ),
              ),
          ),
          where,
        ),
      ),
    )
    .onConflictDoNothing();
}

/**
 * Queues Feed revalidation for the user's Feeds among `feedIds`. A queued
 * backfill becomes revalidation, which covers it; a queued revalidation stands.
 */
export async function queueFeedRevalidation(
  database: FeedDatabase,
  userId: string,
  feedIds: number[],
) {
  await database
    .insert(feedOriginChecks)
    .select(dueChecks(database, userId, "full", inArray(feeds.id, feedIds)))
    .onConflictDoUpdate({
      target: feedOriginChecks.feedId,
      set: { type: "full", attempts: 0, nextAttemptAt: new Date() },
      setWhere: eq(feedOriginChecks.type, "light"),
    });
}

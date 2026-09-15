import { and, asc, count, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { db as Database } from "~/server/db";
import type { FetchableOrigin } from "./types";
import { feedOrigins, feeds } from "~/server/db/schema";

export const RSS_FEED_PAGE_SIZE = 50;

/**
 * Due origins: scheduled at or before `now` (or never scheduled) on an active
 * Feed. Origins are paged directly so each keeps its own clock; the Feed join
 * supplies the active flag, which lives only on the Feed.
 */
function dueOriginCondition(userId: string, now: Date) {
  return and(
    eq(feedOrigins.userId, userId),
    eq(feeds.isActive, true),
    or(lte(feedOrigins.nextFetchAt, now), isNull(feedOrigins.nextFetchAt)),
  );
}

export async function countDueFeeds(
  database: typeof Database,
  userId: string,
  now: Date,
) {
  const result = await database
    .select({ value: count() })
    .from(feedOrigins)
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .where(dueOriginCondition(userId, now))
    .get();
  return result?.value ?? 0;
}

export async function getDueFeedPage(
  database: typeof Database,
  input: { userId: string; afterOriginId?: number; now: Date },
): Promise<FetchableOrigin[]> {
  const rows = await database
    .select({ origin: feedOrigins, feed: feeds })
    .from(feedOrigins)
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .where(
      and(
        dueOriginCondition(input.userId, input.now),
        input.afterOriginId
          ? gt(feedOrigins.id, input.afterOriginId)
          : undefined,
      ),
    )
    .orderBy(asc(feedOrigins.id))
    .limit(RSS_FEED_PAGE_SIZE)
    .all();
  return rows;
}

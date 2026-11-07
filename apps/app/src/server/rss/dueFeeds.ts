import {
  and,
  asc,
  countDistinct,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import type { db as Database } from "~/server/db";
import type { FetchableOrigin } from "./types";
import { hydrateOrigin, originSelection } from "~/server/feeds/origins";
import {
  feedOriginAtproto,
  feedOriginRss,
  feedOrigins,
  feeds,
} from "~/server/db/schema";

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
    .select({ value: countDistinct(feedOrigins.feedId) })
    .from(feedOrigins)
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .where(dueOriginCondition(userId, now))
    .get();
  return result?.value ?? 0;
}

export async function getDueFeedPage(
  database: typeof Database,
  input: { userId: string; afterFeedId?: number; now: Date },
): Promise<FetchableOrigin[]> {
  const feedPage = database
    .select({ id: feedOrigins.feedId })
    .from(feedOrigins)
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .where(
      and(
        dueOriginCondition(input.userId, input.now),
        input.afterFeedId
          ? gt(feedOrigins.feedId, input.afterFeedId)
          : undefined,
      ),
    )
    .groupBy(feedOrigins.feedId)
    .orderBy(asc(feedOrigins.feedId))
    .limit(RSS_FEED_PAGE_SIZE);
  const rows = await database
    .select({ ...originSelection, feed: feeds })
    .from(feedOrigins)
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .leftJoin(feedOriginRss, eq(feedOriginRss.originId, feedOrigins.id))
    .leftJoin(feedOriginAtproto, eq(feedOriginAtproto.originId, feedOrigins.id))
    .where(
      and(
        dueOriginCondition(input.userId, input.now),
        inArray(feedOrigins.feedId, feedPage),
      ),
    )
    .orderBy(asc(feedOrigins.feedId), asc(feedOrigins.id))
    .all();
  return rows.map((row) => ({ feed: row.feed, origin: hydrateOrigin(row) }));
}

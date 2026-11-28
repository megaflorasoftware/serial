import { and, asc, countDistinct, eq, gt, inArray } from "drizzle-orm";
import type { db as Database } from "~/server/db";
import type { FetchableOrigin } from "./types";
import { hydrateOrigin, originSelection } from "~/server/feeds/origins";
import { originIsDue } from "~/server/feeds/schedule";
import {
  feedOriginAtproto,
  feedOriginRss,
  feedOrigins,
  feeds,
} from "~/server/db/schema";

export const RSS_FEED_PAGE_SIZE = 50;

/**
 * Due origins: scheduled at or before `now` on an active Feed. Origins are
 * paged directly so each keeps its own clock. The schedule alone selects them,
 * since an inactive Feed's origins are unscheduled; the Feed join only guards
 * the due rows against a schedule that outlived its Feed's active flag.
 */
function dueOriginCondition(userId: string, now: Date) {
  return and(
    eq(feedOrigins.userId, userId),
    originIsDue(now),
    eq(feeds.isActive, true),
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

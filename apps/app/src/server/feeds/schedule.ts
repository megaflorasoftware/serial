import { and, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { FeedDatabase } from "./origins";
import { feedOrigins } from "~/server/db/schema";

/**
 * `next_fetch_at` is the only signal that an origin is due. NULL means
 * unscheduled, which is how the origins of an inactive Feed rest. Only
 * creating an origin and activating its Feed schedule an unscheduled origin;
 * every other writer moves an existing schedule.
 */

type ScheduleWriter = Pick<FeedDatabase, "update">;

/** A new origin is due at once on an active Feed and unscheduled on an inactive one. */
export function initialOriginSchedule(isActive: boolean, now: Date) {
  return isActive ? now : null;
}

/** The origin's scheduled time has passed. Unscheduled origins never match. */
export function originIsDue(now: Date) {
  return lte(feedOrigins.nextFetchAt, now);
}

export const originIsScheduled = isNotNull(feedOrigins.nextFetchAt);

function originsOfFeeds(userId: string, feedIds: number[]) {
  return and(
    eq(feedOrigins.userId, userId),
    inArray(feedOrigins.feedId, feedIds),
  );
}

/** Newly active Feeds: their unscheduled origins become due at once. */
export function scheduleFeedOrigins(
  database: ScheduleWriter,
  input: { userId: string; feedIds: number[]; now: Date },
) {
  return database
    .update(feedOrigins)
    .set({ nextFetchAt: input.now })
    .where(
      and(
        originsOfFeeds(input.userId, input.feedIds),
        isNull(feedOrigins.nextFetchAt),
      ),
    );
}

/** Newly inactive Feeds: their origins leave the schedule. */
export function unscheduleFeedOrigins(
  database: ScheduleWriter,
  input: { userId: string; feedIds: number[] },
) {
  return database
    .update(feedOrigins)
    .set({ nextFetchAt: null })
    .where(and(originsOfFeeds(input.userId, input.feedIds), originIsScheduled));
}

/**
 * Pulls scheduled origins forward so the next refresh visits them. An
 * unscheduled origin belongs to an inactive Feed and stays unscheduled.
 */
export function makeOriginsDue(
  database: ScheduleWriter,
  origins: SQL | undefined,
  now: Date,
) {
  return database
    .update(feedOrigins)
    .set({ nextFetchAt: now })
    .where(and(origins, gt(feedOrigins.nextFetchAt, now)));
}

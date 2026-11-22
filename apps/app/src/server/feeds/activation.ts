import { and, eq, inArray } from "drizzle-orm";
import { scheduleFeedOrigins, unscheduleFeedOrigins } from "./schedule";
import type { FeedDatabase } from "./origins";
import { feeds } from "~/server/db/schema";

/**
 * The one writer of a Feed's active flag. The flag and the origin schedule
 * change together: activating schedules the Feed's origins now, deactivating
 * unschedules them. Returns how many of the user's Feeds matched.
 */
export async function setFeedsActive(
  database: FeedDatabase,
  input: {
    userId: string;
    feedIds: number[];
    isActive: boolean;
    now?: Date;
  },
) {
  if (input.feedIds.length === 0) return 0;
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(feeds)
      .set({ isActive: input.isActive })
      .where(
        and(eq(feeds.userId, input.userId), inArray(feeds.id, input.feedIds)),
      );
    if (input.isActive)
      await scheduleFeedOrigins(tx, { ...input, now: input.now ?? new Date() });
    else await unscheduleFeedOrigins(tx, input);
    return updated.rowsAffected;
  });
}

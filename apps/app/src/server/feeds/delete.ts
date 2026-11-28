import { and, eq, inArray } from "drizzle-orm";
import type { FeedDatabase } from "./origins";
import type { db } from "~/server/db";
import { feeds, views, viewSections } from "~/server/db/schema";
import { VIEW_LAYOUT_ITEM_TYPE } from "~/server/db/constants";
import { requestSyncForFeedChange } from "~/server/publication-sync/requests";
import { wakeRequestedSync } from "~/server/publication-sync/wake";

/**
 * A deletion the user asked for. Subscription sync hears of it first, while the
 * Feeds' origins still say whether a publication is going, and runs once the
 * deletion has committed. Sync's own removals call `deleteUserFeeds` directly.
 */
export async function deleteFeedsAtUserRequest(
  database: typeof db,
  userId: string,
  feedIds: number[],
) {
  const { deleted, syncRequested } = await database.transaction(async (tx) => ({
    syncRequested: await requestSyncForFeedChange(tx, userId, feedIds),
    deleted: await deleteUserFeeds(tx, userId, feedIds),
  }));
  wakeRequestedSync(database, syncRequested);
  return deleted;
}

/** Caller owns the transaction; Feed deletion and layout cleanup commit together. */
export async function deleteUserFeeds(
  database: FeedDatabase,
  userId: string,
  feedIds: number[],
) {
  if (!feedIds.length) return [];
  const deleted = await database
    .delete(feeds)
    .where(and(eq(feeds.userId, userId), inArray(feeds.id, feedIds)))
    .returning({ id: feeds.id });
  if (!deleted.length) return [];
  const ownedViews = database
    .select({ id: views.id })
    .from(views)
    .where(eq(views.userId, userId));
  await database.delete(viewSections).where(
    and(
      eq(viewSections.itemType, VIEW_LAYOUT_ITEM_TYPE.FEED),
      inArray(
        viewSections.itemId,
        deleted.map((feed) => feed.id),
      ),
      inArray(viewSections.viewId, ownedViews),
    ),
  );
  return deleted;
}

import { and, eq, inArray } from "drizzle-orm";
import type { FeedDatabase } from "./origins";
import { feeds, views, viewSections } from "~/server/db/schema";
import { VIEW_LAYOUT_ITEM_TYPE } from "~/server/db/constants";
import { requestSyncForFeedChange } from "~/server/publication-sync/requests";

/**
 * A deletion the user asked for. Subscription sync hears of it first, while the
 * Feeds' origins still say whether a publication is going. Sync's own removals
 * call `deleteUserFeeds` directly.
 */
export async function deleteFeedsAtUserRequest(
  database: FeedDatabase,
  userId: string,
  feedIds: number[],
) {
  await requestSyncForFeedChange(database, userId, feedIds);
  return deleteUserFeeds(database, userId, feedIds);
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

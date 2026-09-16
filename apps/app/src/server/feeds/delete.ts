import { and, eq, inArray } from "drizzle-orm";
import type { FeedDatabase } from "./origins";
import { feeds, views, viewSections } from "~/server/db/schema";
import { VIEW_LAYOUT_ITEM_TYPE } from "~/server/db/constants";

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

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  ApplicationFeed,
  ApplicationFeedItem,
  ApplicationView,
  DatabaseContentCategory,
  DatabaseFeedCategory,
} from "~/server/db/schema";
import type { FetchFeedsStatus } from "~/server/rss/fetchFeeds";
import { prepareArrayChunks } from "~/lib/iterators";
import {
  INBOX_VIEW_ID,
  INBOX_VIEW_PLACEMENT,
} from "~/lib/data/views/constants";
import {
  buildContentTypeFilter,
  buildTimeWindowFilter,
  buildViewCategoryFilter,
  buildVisibilityFilter,
} from "~/lib/data/feed-items/filters";
import { sortViewsByPlacement } from "~/lib/data/views/utils";

import {
  contentCategories,
  feedCategories,
  feedItems,
  feeds,
  feedsSchema,
  viewCategories,
  views,
} from "~/server/db/schema";
import {
  FEED_ITEM_ORIENTATION,
  VIEW_CONTENT_TYPE,
  VIEW_READ_STATUS,
} from "~/server/db/constants";
import { protectedProcedure } from "~/server/orpc/base";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { parseArrayOfSchema } from "~/lib/schemas/utils";

export type GetByViewChunk =
  | { type: "views"; views: ApplicationView[] }
  | { type: "feeds"; feeds: ApplicationFeed[] }
  | { type: "feed-categories"; feedCategories: DatabaseFeedCategory[] }
  | { type: "content-categories"; contentCategories: DatabaseContentCategory[] }
  | { type: "feed-items"; viewId: number; feedItems: ApplicationFeedItem[] }
  | { type: "feed-status"; feedId: number; status: FetchFeedsStatus };

/**
 * Build the Inbox view server-side
 * Replicates client-side logic from src/lib/data/views/index.ts
 */
function buildInboxView(
  userId: string,
  contentCategoriesList: DatabaseContentCategory[],
  customViews: ApplicationView[],
): ApplicationView {
  const allCategoryIdsSet = new Set(
    contentCategoriesList.map((category) => category.id),
  );
  const customViewCategoryIdsSet = new Set(
    customViews.flatMap((view) => view.categoryIds),
  );

  const inboxCategoryIds = [...allCategoryIdsSet].filter(
    (id) => !customViewCategoryIdsSet.has(id),
  );

  const now = new Date();

  return {
    id: INBOX_VIEW_ID,
    name: "Inbox",
    daysWindow: 30,
    orientation: FEED_ITEM_ORIENTATION.HORIZONTAL,
    contentType: VIEW_CONTENT_TYPE.LONGFORM,
    readStatus: VIEW_READ_STATUS.UNREAD,
    placement: INBOX_VIEW_PLACEMENT,
    userId,
    createdAt: now,
    updatedAt: now,
    categoryIds: inboxCategoryIds,
    isDefault: true,
  };
}

const GET_BY_VIEW_CHUNK_SIZE = 100;

export const getByView = protectedProcedure.handler(async function* ({ context }) {
  // Step 1: Fetch all prerequisite data in parallel
  const [viewsList, feedsList, contentCategoriesList, feedCategoriesList] =
    await Promise.all([
      // Views
      context.db
        .select()
        .from(views)
        .where(eq(views.userId, context.user.id))
        .orderBy(asc(views.placement)),

      // Feeds
      context.db.query.feeds.findMany({
        where: eq(feeds.userId, context.user.id),
      }),

      // Content categories
      context.db
        .select()
        .from(contentCategories)
        .where(eq(contentCategories.userId, context.user.id))
        .orderBy(asc(contentCategories.name)),

      // Feed categories
      context.db.select().from(feedCategories),
    ]);

  // Get view categories
  const viewCategoriesList = await context.db.select().from(viewCategories);

  // Transform views to ApplicationView with categoryIds
  const customViews: ApplicationView[] = viewsList.map((view) => ({
    ...view,
    isDefault: false,
    categoryIds: viewCategoriesList
      .filter((vc) => vc.viewId === view.id)
      .map((vc) => vc.categoryId)
      .filter((id): id is number => id !== null),
  }));

  // Build inbox view
  const inboxView = buildInboxView(
    context.user.id,
    contentCategoriesList,
    customViews,
  );

  // All views including inbox, sorted by placement
  const allViews = sortViewsByPlacement([...customViews, inboxView]);

  // Parse feeds to ApplicationFeed
  const applicationFeeds = parseArrayOfSchema(feedsList, feedsSchema);

  // Step 2: Yield prerequisite data chunks
  yield {
    type: "views",
    views: allViews,
  } as GetByViewChunk;

  yield {
    type: "feeds",
    feeds: applicationFeeds,
  } as GetByViewChunk;

  yield {
    type: "content-categories",
    contentCategories: contentCategoriesList,
  } as GetByViewChunk;

  // Filter feed categories to only those belonging to user's content categories
  const userContentCategoryIds = new Set(
    contentCategoriesList.map((cc) => cc.id),
  );
  const userFeedCategories = feedCategoriesList.filter((fc) =>
    userContentCategoryIds.has(fc.categoryId),
  );

  yield {
    type: "feed-categories",
    feedCategories: userFeedCategories,
  } as GetByViewChunk;

  // Step 3: Query feed items with filters for the first view
  const firstView = allViews[0];
  const feedIds = feedsList.map((feed) => feed.id);

  if (feedIds.length === 0 || !firstView) {
    return;
  }

  // Build combined filter for the first view
  const filterConditions = [
    inArray(feedItems.feedId, feedIds),
    buildVisibilityFilter("unread"),
    buildViewCategoryFilter(firstView, userFeedCategories, feedIds),
    buildContentTypeFilter(firstView.contentType, applicationFeeds),
    buildTimeWindowFilter(firstView.daysWindow),
  ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  const filter = filterConditions.length > 0 ? and(...filterConditions) : undefined;

  const itemsData = await context.db.query.feedItems.findMany({
    where: filter,
    orderBy: desc(feedItems.postedAt),
  });

  const existingApplicationFeedItems = itemsData.map((item) => {
    const itemFeed = feedsList.find((f) => f.id === item.feedId);

    return {
      ...item,
      platform: itemFeed?.platform ?? "youtube",
    } as ApplicationFeedItem;
  });

  // Step 4: Yield filtered feed items in chunks
  for (const chunk of prepareArrayChunks(
    existingApplicationFeedItems,
    GET_BY_VIEW_CHUNK_SIZE,
  )) {
    yield {
      type: "feed-items",
      viewId: firstView.id,
      feedItems: chunk,
    } as GetByViewChunk;
  }

  // Step 5: Run fetch and insert for fresh items (client will filter)
  for await (const feedResult of fetchAndInsertFeedData(context, feedsList)) {
    yield {
      type: "feed-status",
      status: feedResult.status,
      feedId: feedResult.id,
    } as GetByViewChunk;

    if (feedResult.status !== "success") {
      continue;
    }

    for (const chunk of prepareArrayChunks(
      feedResult.feedItems,
      GET_BY_VIEW_CHUNK_SIZE,
    )) {
      yield {
        type: "feed-items",
        viewId: firstView.id,
        feedItems: chunk,
      } as GetByViewChunk;
    }
  }

  return;
});

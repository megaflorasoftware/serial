import { z } from "zod";
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
import { INBOX_VIEW_ID } from "~/lib/data/views/constants";
import {
  buildContentTypeFilter,
  buildTimeWindowFilter,
  buildViewCategoryFilter,
  buildVisibilityFilter,
  isFeedCompatibleWithContentType,
} from "~/lib/data/feed-items/filters";
import { sortViewsByPlacement } from "~/lib/data/views/utils";
import { buildUncategorizedView } from "~/server/api/utils/buildUncategorizedView";

import {
  contentCategories,
  feedCategories,
  feedItems,
  feeds,
  feedsSchema,
  viewCategories,
  views,
} from "~/server/db/schema";
import { protectedProcedure } from "~/server/orpc/base";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { parseArrayOfSchema } from "~/lib/schemas/utils";

export type GetByViewChunk =
  | { type: "views"; views: ApplicationView[] }
  | { type: "feeds"; feeds: ApplicationFeed[] }
  | { type: "feed-categories"; feedCategories: DatabaseFeedCategory[] }
  | { type: "content-categories"; contentCategories: DatabaseContentCategory[] }
  | { type: "feed-items"; viewId: number; feedItems: ApplicationFeedItem[] }
  | { type: "feed-status"; feedId: number; status: FetchFeedsStatus }
  | { type: "view-feeds"; viewId: number; feedIds: number[] }
  | { type: "initial-data-complete" }
  | { type: "error"; message: string; phase: string };

export type RevalidateViewChunk =
  | { type: "views"; views: ApplicationView[] }
  | { type: "feed-items"; viewId: number; feedItems: ApplicationFeedItem[] }
  | { type: "view-feeds"; viewId: number; feedIds: number[] }
  | { type: "error"; message: string; phase: string };

/**
 * Compute which feeds belong to a view based on categories and content type.
 * This replicates client-side logic from useCheckFeedBelongsToView.
 */
function computeFeedsForView(
  view: ApplicationView,
  allFeeds: ApplicationFeed[],
  allFeedCategories: DatabaseFeedCategory[],
  customViews: ApplicationView[],
  customViewCategoryIds: Set<number>,
): number[] {
  const feedIds: number[] = [];

  for (const feed of allFeeds) {
    // Check if feed's content type is compatible with the view
    const isCompatible = isFeedCompatibleWithContentType(
      feed.platform,
      view.contentType,
    );
    if (!isCompatible) {
      continue;
    }

    // Get categories this feed belongs to
    const feedCategoryIds = allFeedCategories
      .filter((fc) => fc.feedId === feed.id)
      .map((fc) => fc.categoryId);

    // For Uncategorized view, include feeds that are NOT in any custom view category
    // or feeds that are in the Uncategorized view's category list
    if (view.id === INBOX_VIEW_ID) {
      // Check if feed has any category that's in a custom view with compatible content type
      const wouldAppearInCustomView = feedCategoryIds.some((categoryId) => {
        if (!customViewCategoryIds.has(categoryId)) return false;

        const viewsWithCategory = customViews.filter((v) =>
          v.categoryIds.includes(categoryId),
        );

        return viewsWithCategory.some((v) =>
          isFeedCompatibleWithContentType(feed.platform, v.contentType),
        );
      });

      // Feed belongs to Uncategorized if it wouldn't appear in any custom view
      // OR if it has no categories at all
      if (!wouldAppearInCustomView) {
        feedIds.push(feed.id);
        continue;
      }

      // Also check if feed's categories overlap with Uncategorized view's categoryIds
      if (
        feedCategoryIds.some((categoryId) =>
          view.categoryIds.includes(categoryId),
        )
      ) {
        feedIds.push(feed.id);
        continue;
      }
    } else {
      // Empty categoryIds means "all categories" (no category filter)
      if (view.categoryIds.length === 0) {
        feedIds.push(feed.id);
      } else {
        // For views with specific categories, check if any of the feed's categories are in the view
        const categoryMatch = feedCategoryIds.some((categoryId) =>
          view.categoryIds.includes(categoryId),
        );

        if (categoryMatch) {
          feedIds.push(feed.id);
        }
      }
    }
  }

  return feedIds;
}

const GET_BY_VIEW_CHUNK_SIZE = 100;
const INITIAL_ITEMS_PER_VIEW = 20;

export const getAllByView = protectedProcedure.handler(async function* ({
  context,
}) {
  // Step 1: Fetch all prerequisite data in parallel
  let initialData;

  try {
    initialData = await Promise.all([
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
    ]);
  } catch (error) {
    yield {
      type: "error",
      message:
        error instanceof Error ? error.message : "Failed to fetch initial data",
      phase: "initial-fetch",
    } as GetByViewChunk;
    return;
  }

  const [viewsList, feedsList, contentCategoriesList] = initialData;

  // Fetch feed categories filtered by user's content categories
  const userContentCategoryIds = contentCategoriesList.map((cc) => cc.id);
  const feedCategoriesList =
    userContentCategoryIds.length > 0
      ? await context.db
          .select()
          .from(feedCategories)
          .where(inArray(feedCategories.categoryId, userContentCategoryIds))
      : [];

  // Get view categories filtered by user's views
  const userViewIds = viewsList.map((v) => v.id);
  const viewCategoriesList =
    userViewIds.length > 0
      ? await context.db
          .select()
          .from(viewCategories)
          .where(inArray(viewCategories.viewId, userViewIds))
      : [];

  // Transform views to ApplicationView with categoryIds
  const customViews: ApplicationView[] = viewsList.map((view) => ({
    ...view,
    isDefault: false,
    categoryIds: viewCategoriesList
      .filter((vc) => vc.viewId === view.id)
      .map((vc) => vc.categoryId)
      .filter((id): id is number => id !== null),
  }));

  const uncategorizedView = buildUncategorizedView(
    context.user.id,
    contentCategoriesList,
    customViews,
  );

  const allViews = sortViewsByPlacement([...customViews, uncategorizedView]);

  // Parse feeds to ApplicationFeed
  const applicationFeeds = parseArrayOfSchema(feedsList, feedsSchema);

  // Pre-build a Map for O(1) feed lookups by ID
  const feedsById = new Map(feedsList.map((f) => [f.id, f]));

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

  // Collect all category IDs used by custom views (for Uncategorized view exclusion)
  const customViewCategoryIds = new Set(
    customViews.flatMap((v) => v.categoryIds),
  );

  yield {
    type: "feed-categories",
    feedCategories: feedCategoriesList,
  } as GetByViewChunk;

  // Step 3: Yield view-feeds chunks for each view
  for (const view of allViews) {
    const feedIdsForView = computeFeedsForView(
      view,
      applicationFeeds,
      feedCategoriesList,
      customViews,
      customViewCategoryIds,
    );

    yield {
      type: "view-feeds",
      viewId: view.id,
      feedIds: feedIdsForView,
    } as GetByViewChunk;
  }

  const firstView = allViews[0];
  const feedIds = feedsList.map((feed) => feed.id);

  if (feedIds.length === 0 || !firstView) {
    yield { type: "initial-data-complete" } as GetByViewChunk;
    return;
  }

  // Step 4: Query and yield initial items (first 20) for EACH view
  // This allows the client to render immediately without showing the loading screen
  for (const view of allViews) {
    try {
      const filterConditions = [
        inArray(feedItems.feedId, feedIds),
        buildVisibilityFilter("unread"),
        buildViewCategoryFilter(
          view,
          feedCategoriesList,
          feedIds,
          customViewCategoryIds,
          customViews,
          applicationFeeds,
        ),
        buildContentTypeFilter(view.contentType, applicationFeeds),
        buildTimeWindowFilter(view.daysWindow),
      ].filter(Boolean);

      const filter =
        filterConditions.length > 0 ? and(...filterConditions) : undefined;

      const initialItems = await context.db.query.feedItems.findMany({
        where: filter,
        orderBy: desc(feedItems.postedAt),
        limit: INITIAL_ITEMS_PER_VIEW,
      });

      if (initialItems.length > 0) {
        const applicationItems = initialItems.map((item) => {
          const itemFeed = feedsById.get(item.feedId);
          return {
            ...item,
            platform: itemFeed?.platform ?? "youtube",
          } as ApplicationFeedItem;
        });

        yield {
          type: "feed-items",
          viewId: view.id,
          feedItems: applicationItems,
        } as GetByViewChunk;
      }
    } catch (error) {
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : `Failed to fetch initial items for view ${view.id}`,
        phase: "initial-items",
      } as GetByViewChunk;
      // Continue to next view instead of stopping
    }
  }

  // Signal that initial data is complete - client can hide loading screen
  yield { type: "initial-data-complete" } as GetByViewChunk;

  // Step 5: Query remaining feed items for the first view
  try {
    const filterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter("unread"),
      buildViewCategoryFilter(
        firstView,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
      ),
      buildContentTypeFilter(firstView.contentType, applicationFeeds),
      buildTimeWindowFilter(firstView.daysWindow),
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const filter =
      filterConditions.length > 0 ? and(...filterConditions) : undefined;

    const itemsData = await context.db.query.feedItems.findMany({
      where: filter,
      orderBy: desc(feedItems.postedAt),
    });

    const existingApplicationFeedItems = itemsData.map((item) => {
      const itemFeed = feedsById.get(item.feedId);

      return {
        ...item,
        platform: itemFeed?.platform ?? "youtube",
      } as ApplicationFeedItem;
    });

    // Yield remaining feed items in chunks (client will deduplicate)
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
  } catch (error) {
    yield {
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "Failed to fetch remaining feed items",
      phase: "remaining-items",
    } as GetByViewChunk;
  }

  // Step 6: Run fetch and insert for fresh items (client will filter)
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

const REVALIDATE_VIEW_CHUNK_SIZE = 100;

export const revalidateView = protectedProcedure
  .input(z.object({ viewId: z.number() }))
  .handler(async function* ({ context, input }) {
    // Step 1: Fetch all prerequisite data in parallel
    let initialData;

    try {
      initialData = await Promise.all([
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
      ]);
    } catch (error) {
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to fetch initial data",
        phase: "initial-fetch",
      } as RevalidateViewChunk;
      return;
    }

    const [viewsList, feedsList, contentCategoriesList] = initialData;

    // Fetch feed categories filtered by user's content categories
    const userContentCategoryIds = contentCategoriesList.map((cc) => cc.id);
    const feedCategoriesList =
      userContentCategoryIds.length > 0
        ? await context.db
            .select()
            .from(feedCategories)
            .where(inArray(feedCategories.categoryId, userContentCategoryIds))
        : [];

    // Get view categories filtered by user's views
    const userViewIds = viewsList.map((v) => v.id);
    const viewCategoriesList =
      userViewIds.length > 0
        ? await context.db
            .select()
            .from(viewCategories)
            .where(inArray(viewCategories.viewId, userViewIds))
        : [];

    // Transform views to ApplicationView with categoryIds
    const customViews: ApplicationView[] = viewsList.map((view) => ({
      ...view,
      isDefault: false,
      categoryIds: viewCategoriesList
        .filter((vc) => vc.viewId === view.id)
        .map((vc) => vc.categoryId)
        .filter((id): id is number => id !== null),
    }));

    // Build Uncategorized view
    const uncategorizedView = buildUncategorizedView(
      context.user.id,
      contentCategoriesList,
      customViews,
    );

    // All views including Uncategorized, sorted by placement
    const allViews = sortViewsByPlacement([...customViews, uncategorizedView]);

    // Parse feeds to ApplicationFeed
    const applicationFeeds = parseArrayOfSchema(feedsList, feedsSchema);

    // Pre-build a Map for O(1) feed lookups by ID
    const feedsById = new Map(feedsList.map((f) => [f.id, f]));

    // Collect all category IDs used by custom views (for Uncategorized view exclusion)
    const customViewCategoryIds = new Set(
      customViews.flatMap((v) => v.categoryIds),
    );

    // Step 2: Yield views
    yield {
      type: "views",
      views: allViews,
    } as RevalidateViewChunk;

    // Step 3: Yield view-feeds chunks for each view
    for (const view of allViews) {
      const feedIdsForView = computeFeedsForView(
        view,
        applicationFeeds,
        feedCategoriesList,
        customViews,
        customViewCategoryIds,
      );

      yield {
        type: "view-feeds",
        viewId: view.id,
        feedIds: feedIdsForView,
      } as RevalidateViewChunk;
    }

    const feedIds = feedsList.map((feed) => feed.id);

    if (feedIds.length === 0) {
      return;
    }

    // Step 3: Find target view
    const targetView =
      input.viewId === INBOX_VIEW_ID
        ? uncategorizedView
        : allViews.find((v) => v.id === input.viewId);

    if (!targetView) {
      return;
    }

    // Helper function to query and yield feed items for a view
    async function* queryAndYieldFeedItemsForView(
      view: ApplicationView,
    ): AsyncGenerator<RevalidateViewChunk> {
      try {
        const filterConditions = [
          inArray(feedItems.feedId, feedIds),
          buildVisibilityFilter("unread"),
          buildViewCategoryFilter(
            view,
            feedCategoriesList,
            feedIds,
            customViewCategoryIds,
            customViews,
            applicationFeeds,
          ),
          buildContentTypeFilter(view.contentType, applicationFeeds),
          buildTimeWindowFilter(view.daysWindow),
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);

        const filter =
          filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const itemsData = await context.db.query.feedItems.findMany({
          where: filter,
          orderBy: desc(feedItems.postedAt),
        });

        const applicationFeedItems = itemsData.map((item) => {
          const itemFeed = feedsById.get(item.feedId);

          return {
            ...item,
            platform: itemFeed?.platform ?? "youtube",
          } as ApplicationFeedItem;
        });

        for (const chunk of prepareArrayChunks(
          applicationFeedItems,
          REVALIDATE_VIEW_CHUNK_SIZE,
        )) {
          yield {
            type: "feed-items",
            viewId: view.id,
            feedItems: chunk,
          } as RevalidateViewChunk;
        }
      } catch (error) {
        yield {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : `Failed to fetch items for view ${view.id}`,
          phase: "feed-items",
        } as RevalidateViewChunk;
      }
    }

    // Step 4: Query feed items for target view
    yield* queryAndYieldFeedItemsForView(targetView);

    // Step 5: If target is not Uncategorized, also query feed items for Uncategorized
    if (targetView.id !== INBOX_VIEW_ID) {
      yield* queryAndYieldFeedItemsForView(uncategorizedView);
    }

    return;
  });

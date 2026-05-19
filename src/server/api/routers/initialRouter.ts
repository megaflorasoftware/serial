import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  GET_BY_VIEW_CHUNK_SIZE,
  INITIAL_ITEMS_PER_VIEW,
  ITEMS_BY_VISIBILITY_CHUNK_SIZE,
  ITEMS_PER_PAGE,
  REVALIDATE_VIEW_CHUNK_SIZE,
} from "../constants";
import { publisher, trackChannelConnection } from "../publisher";
import { insertFeedWithCategories } from "./feed-router/utils";
import type { SQL } from "drizzle-orm";
import type { VisibilityFilter } from "~/lib/data/atoms";
import type {
  ApplicationFeed,
  ApplicationFeedItem,
  ApplicationView,
  DatabaseContentCategory,
  DatabaseFeed,
  DatabaseFeedCategory,
  DatabaseView,
  DatabaseViewCategory,
  DatabaseViewFeed,
  DatabaseViewSection,
} from "~/server/db/schema";
import type { ORPCContext } from "~/server/orpc/base";
import type { FetchFeedsStatus } from "~/server/rss/fetchFeeds";
import { captureException, logDebug, logError } from "~/server/logger";
import {
  checkUserRefreshEligibility,
  getFeedsActivationBudget,
} from "~/server/subscriptions/helpers";
import { visibilityFilterSchema } from "~/lib/data/atoms";
import {
  buildContentTypeFilter,
  buildTimeWindowFilter,
  buildViewCategoryFilter,
  buildVisibilityFilter,
  isFeedCompatibleWithContentType,
} from "~/lib/data/feed-items/filters";
import { INBOX_VIEW_ID } from "~/lib/data/views/constants";
import { sortViewsByPlacement } from "~/lib/data/views/utils";
import { prepareArrayChunks } from "~/lib/iterators";
import { buildUncategorizedView } from "~/server/api/utils/buildUncategorizedView";

import { parseArrayOfSchema } from "~/lib/schemas/utils";
import { dbSemaphore } from "~/lib/semaphore";
import { workerPool } from "~/lib/workerPool";
import {
  contentCategories,
  feedCategories,
  feedItems,
  feeds,
  feedsSchema,
  viewCategories,
  viewFeeds,
  views,
  viewSections,
} from "~/server/db/schema";
import { protectedProcedure } from "~/server/orpc/base";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { refreshUserFeeds } from "~/server/rss/refreshUserFeeds";

export type PaginationCursor = {
  placement?: number;
  postedAt: Date;
  id: string;
  isWatchedUpdatedAt?: Date | null;
} | null;

export type ClientManifestEntry = {
  id: string;
  contentHash: string | null;
};

export type DiffEntry =
  | { status: "unchanged"; id: string }
  | { status: "updated"; item: ApplicationFeedItem }
  | { status: "new"; item: ApplicationFeedItem }
  | { status: "deleted"; id: string };

/** Feed item without the heavy `content` field, used for the initial lightweight fetch.
 *  `contentSnippet` is kept because large-list / large-grid layouts use it for the
 *  description line and we want that visible immediately. */
export type LightweightFeedItem = Omit<ApplicationFeedItem, "content">;

/** Fulltext content patch for items that need it after the lightweight fetch. */
export type FeedItemFulltext = {
  id: string;
  content: string;
  contentSnippet: string;
};

type ViewBoundary = {
  oldestPostedAt: Date | null;
  sentItemIds: Set<string>;
};

type FetchContentForViewResult = {
  chunk: ViewDataChunk;
  boundary: ViewBoundary;
};

export type ViewDataChunk =
  | {
      type: "feed-items";
      viewId?: number;
      feedId?: number;
      feedItems: ApplicationFeedItem[];
      visibilityFilter?: string;
      hasMore?: boolean;
      nextCursor?: PaginationCursor;
    }
  | { type: "error"; message: string; phase: string; viewId: number };

export type GetByViewChunk =
  | { type: "views"; views: ApplicationView[] }
  | { type: "feeds"; feeds: ApplicationFeed[] }
  | { type: "feed-categories"; feedCategories: DatabaseFeedCategory[] }
  | { type: "content-categories"; contentCategories: DatabaseContentCategory[] }
  | { type: "feed-status"; feedId: number; status: FetchFeedsStatus }
  | { type: "view-feeds"; viewId: number; feedIds: number[] }
  | { type: "initial-data-complete" }
  | { type: "refresh-start"; totalFeeds: number; nextRefreshAt: Date | null }
  | { type: "refresh-complete" }
  | { type: "view-items"; viewId: number; feedItemIds: string[] }
  | {
      type: "import-feed-inserted";
      feedUrl: string;
      feedId: number;
      feed: ApplicationFeed;
    }
  | { type: "import-feed-error"; feedUrl: string; error: string }
  | { type: "import-start"; totalFeeds: number }
  | {
      type: "import-limit-warning";
      deactivatedCount: number;
      maxActiveFeeds: number;
    }
  | {
      type: "view-diff";
      viewId: number;
      visibilityFilter: string;
      diff: DiffEntry[];
      cursor: PaginationCursor;
      hasMore: boolean;
    }
  | {
      type: "view-lightweight-items";
      viewId: number;
      visibilityFilter: string;
      items: LightweightFeedItem[];
      cursor: PaginationCursor;
      hasMore: boolean;
    }
  | {
      type: "fulltext-items";
      items: FeedItemFulltext[];
    }
  | ViewDataChunk;

export type RevalidateViewChunk =
  | { type: "views"; views: ApplicationView[] }
  | {
      type: "feed-items";
      viewId: number;
      feedItems: ApplicationFeedItem[];
      visibilityFilter?: string;
      hasMore?: boolean;
      nextCursor?: PaginationCursor;
    }
  | { type: "view-feeds"; viewId: number; feedIds: number[] }
  | { type: "error"; message: string; phase: string };

function buildFeedCategoriesMap(
  allFeedCategories: DatabaseFeedCategory[],
): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const fc of allFeedCategories) {
    const existing = map.get(fc.feedId);
    if (existing) {
      existing.push(fc.categoryId);
    } else {
      map.set(fc.feedId, [fc.categoryId]);
    }
  }
  return map;
}

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
  feedCategoriesMap?: Map<number, number[]>,
  customViewFeedIds?: Set<number>,
): number[] {
  const feedIds: number[] = [];

  const categoryMap =
    feedCategoriesMap ?? buildFeedCategoriesMap(allFeedCategories);

  // For non-inbox views, start with directly assigned feeds
  if (view.id !== INBOX_VIEW_ID) {
    feedIds.push(...view.feedIds);
  }

  for (const feed of allFeeds) {
    // Skip if already included via direct assignment
    if (feedIds.includes(feed.id)) continue;

    // Check if feed's content type is compatible with the view
    const isCompatible = isFeedCompatibleWithContentType(
      feed.platform,
      view.contentType,
    );
    if (!isCompatible) {
      continue;
    }

    const feedCategoryIds = categoryMap.get(feed.id) ?? [];

    // For Uncategorized view, include feeds that are NOT in any custom view category
    // or feeds that are in the Uncategorized view's category list
    if (view.id === INBOX_VIEW_ID) {
      // Exclude feeds directly assigned to any custom view
      if (customViewFeedIds?.has(feed.id)) {
        continue;
      }

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
      // Empty categoryIds and feedIds means "all categories" (no category filter)
      if (view.categoryIds.length === 0 && view.feedIds.length === 0) {
        feedIds.push(feed.id);
      } else if (view.categoryIds.length > 0) {
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

interface FetchContentForViewParams {
  feedIds: number[];
  visibilityFilter: VisibilityFilter | undefined;
  feedCategoriesList: any;
  customViewCategoryIds: any;
  customViews: any;
  applicationFeeds: any;
  feedsById: any;
}

async function fetchContentForView(
  context: ORPCContext,
  view: ApplicationView,
  {
    feedIds,
    visibilityFilter,
    feedCategoriesList,
    customViewCategoryIds,
    customViews,
    applicationFeeds,
    feedsById,
  }: FetchContentForViewParams,
): Promise<FetchContentForViewResult> {
  visibilityFilter ??= "unread";

  try {
    const { items } = await queryFeedItemsForView(context, view, {
      visibilityFilter,
      feedIds,
      cursor: null,
      limit: INITIAL_ITEMS_PER_VIEW,
      feedsById,
      feedCategoriesList,
      customViewCategoryIds,
      customViews,
      applicationFeeds,
    });

    return {
      chunk: {
        type: "feed-items",
        viewId: view.id,
        feedItems: items,
        visibilityFilter: visibilityFilter,
      },
      boundary: {
        oldestPostedAt: null,
        sentItemIds: new Set(),
      },
    };
  } catch (error) {
    captureException(error);
    return {
      chunk: {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : `Failed to fetch initial items for view ${view.id}`,
        phase: "initial-items",
        viewId: view.id,
      },
      boundary: {
        oldestPostedAt: null,
        sentItemIds: new Set(),
      },
    };
  }
}

async function* fetchContentForViews(
  context: ORPCContext,
  viewList: ApplicationView[],
  params: FetchContentForViewParams,
): AsyncGenerator<FetchContentForViewResult> {
  const pendingPromises = new Map<number, Promise<FetchContentForViewResult>>();

  for (const view of viewList) {
    // Wrap each promise to include viewId resolution tracking
    const promise = fetchContentForView(context, view, params);
    pendingPromises.set(view.id, promise);
  }

  while (pendingPromises.size > 0) {
    const result = await Promise.any(pendingPromises.values());

    if (
      result.chunk.type === "feed-items" &&
      result.chunk.viewId !== undefined
    ) {
      pendingPromises.delete(result.chunk.viewId);
    } else if (
      result.chunk.type === "error" &&
      result.chunk.viewId !== undefined
    ) {
      pendingPromises.delete(result.chunk.viewId);
    }
    yield result;
  }

  return;
}

/**
 * Compute a diff between the server's authoritative items and the client's
 * cached manifest for a view. Returns DiffEntry[] describing what changed.
 *
 * - "unchanged": client has correct version (matched by contentHash)
 * - "updated": client has stale version (hash mismatch or null hash)
 * - "new": client doesn't have this item
 * - "deleted": client has item but server doesn't (no longer in scope)
 */
function computeViewDiff(
  serverItems: ApplicationFeedItem[],
  clientManifest: ClientManifestEntry[],
): DiffEntry[] {
  const clientMap = new Map<string, string | null>();
  for (const entry of clientManifest) {
    clientMap.set(entry.id, entry.contentHash);
  }

  const serverIds = new Set<string>();
  const diff: DiffEntry[] = [];

  for (const item of serverItems) {
    serverIds.add(item.id);

    if (!clientMap.has(item.id)) {
      diff.push({ status: "new", item });
    } else {
      const clientHash = clientMap.get(item.id);
      // null hash on either side means we can't confirm match — treat as updated
      const hashesMatch =
        clientHash !== null &&
        item.contentHash !== null &&
        clientHash === item.contentHash;

      if (hashesMatch) {
        diff.push({ status: "unchanged", id: item.id });
      } else {
        diff.push({ status: "updated", item });
      }
    }
  }

  // Items the client has that the server doesn't → deleted
  for (const entry of clientManifest) {
    if (!serverIds.has(entry.id)) {
      diff.push({ status: "deleted", id: entry.id });
    }
  }

  return diff;
}

function getUserChannel(userId: string): string {
  return `user:${userId}`;
}

// ============================================================================
// PREREQUISITE DATA HELPERS
// ============================================================================

type PrerequisiteData = {
  viewsList: DatabaseView[];
  feedsList: DatabaseFeed[];
  contentCategoriesList: DatabaseContentCategory[];
  feedCategoriesList: DatabaseFeedCategory[];
  viewCategoriesList: DatabaseViewCategory[];
  viewFeedsList: DatabaseViewFeed[];
  viewSectionsList: DatabaseViewSection[];
};

/**
 * Fetch all prerequisite data needed for view-based queries.
 * Fetches views, feeds, content categories, feed categories, and view categories
 * in parallel batches for optimal performance.
 *
 * Note: This helper should only be called from protected procedures where user is guaranteed to exist.
 */
async function fetchUserPrerequisiteData(
  context: ORPCContext,
): Promise<PrerequisiteData> {
  const userId = context.user!.id;

  // First batch: views, feeds, content categories (no dependencies)
  const [viewsList, feedsList, contentCategoriesList] = await Promise.all([
    context.db
      .select()
      .from(views)
      .where(eq(views.userId, userId))
      .orderBy(asc(views.placement)),
    context.db.query.feeds.findMany({
      where: eq(feeds.userId, userId),
    }),
    context.db
      .select()
      .from(contentCategories)
      .where(eq(contentCategories.userId, userId))
      .orderBy(asc(contentCategories.name)),
  ]);

  // Second batch: feed categories and view categories (depend on first batch)
  const userContentCategoryIds = contentCategoriesList.map((cc) => cc.id);
  const userViewIds = viewsList.map((v) => v.id);

  const [
    feedCategoriesList,
    viewCategoriesList,
    viewFeedsList,
    viewSectionsList,
  ] = await Promise.all([
    userContentCategoryIds.length > 0
      ? context.db
          .select()
          .from(feedCategories)
          .where(inArray(feedCategories.categoryId, userContentCategoryIds))
      : Promise.resolve([]),
    userViewIds.length > 0
      ? context.db
          .select()
          .from(viewCategories)
          .where(inArray(viewCategories.viewId, userViewIds))
      : Promise.resolve([]),
    userViewIds.length > 0
      ? context.db
          .select()
          .from(viewFeeds)
          .where(inArray(viewFeeds.viewId, userViewIds))
      : Promise.resolve([]),
    userViewIds.length > 0
      ? context.db
          .select()
          .from(viewSections)
          .where(inArray(viewSections.viewId, userViewIds))
          .orderBy(asc(viewSections.placement))
      : Promise.resolve([]),
  ]);

  return {
    viewsList,
    feedsList,
    contentCategoriesList,
    feedCategoriesList,
    viewCategoriesList,
    viewFeedsList,
    viewSectionsList,
  };
}

type ApplicationViewsData = {
  customViews: ApplicationView[];
  allViews: ApplicationView[];
  customViewCategoryIds: Set<number>;
  customViewFeedIds: Set<number>;
};

/**
 * Build ApplicationView objects from raw database data.
 * Includes creating the Uncategorized view and sorting by placement.
 */
function buildApplicationViews(
  userId: string,
  viewsList: PrerequisiteData["viewsList"],
  contentCategoriesList: PrerequisiteData["contentCategoriesList"],
  viewCategoriesList: PrerequisiteData["viewCategoriesList"],
  viewFeedsList: PrerequisiteData["viewFeedsList"],
  viewSectionsList: PrerequisiteData["viewSectionsList"],
): ApplicationViewsData {
  // Transform database views to ApplicationView with categoryIds, feedIds, and viewSections
  const customViews: ApplicationView[] = viewsList.map((view) => ({
    ...view,
    isDefault: false,
    categoryIds: viewCategoriesList
      .filter((vc) => vc.viewId === view.id)
      .map((vc) => vc.categoryId)
      .filter((id): id is number => id !== null),
    feedIds: viewFeedsList
      .filter((vf) => vf.viewId === view.id)
      .map((vf) => vf.feedId),
    viewSections: viewSectionsList
      .filter((sv) => sv.viewId === view.id)
      .map((sv) => ({
        ...sv,
        itemType: sv.itemType as "tag" | "feed",
      })),
  }));

  // Build the Uncategorized view
  const uncategorizedView = buildUncategorizedView(
    userId,
    contentCategoriesList,
    customViews,
  );

  // Combine and sort all views
  const allViews = sortViewsByPlacement([...customViews, uncategorizedView]);

  // Collect all category IDs used by custom views (for Uncategorized view exclusion)
  const customViewCategoryIds = new Set(
    customViews.flatMap((v) => v.categoryIds),
  );

  // Collect all feed IDs directly assigned to custom views
  const customViewFeedIds = new Set(customViews.flatMap((v) => v.feedIds));

  return { customViews, allViews, customViewCategoryIds, customViewFeedIds };
}

// ============================================================================
// SHARED HELPER FUNCTIONS
// ============================================================================

type PaginationResult<T> = {
  itemsToReturn: T[];
  hasMore: boolean;
  nextCursor: PaginationCursor;
};

/**
 * Process pagination results: determine hasMore, slice items, create nextCursor.
 * Pass itemsData from a query that fetched limit + 1 items.
 */
function processPaginationResults<
  T extends {
    postedAt: Date;
    id: string;
    placement?: number;
    isWatchedUpdatedAt?: Date | null;
  },
>(itemsData: T[], limit: number): PaginationResult<T> {
  const hasMore = itemsData.length > limit;
  const itemsToReturn = hasMore ? itemsData.slice(0, limit) : itemsData;

  const lastItem = itemsToReturn[itemsToReturn.length - 1];
  const nextCursor: PaginationCursor =
    hasMore && lastItem
      ? {
          placement: lastItem.placement,
          postedAt: lastItem.postedAt,
          id: lastItem.id,
          isWatchedUpdatedAt: lastItem.isWatchedUpdatedAt ?? undefined,
        }
      : null;

  return { itemsToReturn, hasMore, nextCursor };
}

/**
 * Map database feed items to ApplicationFeedItem with platform lookup.
 */
function mapToApplicationFeedItems(
  items: Array<{ feedId: number; postedAt: Date; id: string }>,
  feedsById: Map<number, DatabaseFeed>,
): ApplicationFeedItem[] {
  return items.map((item) => {
    const itemFeed = feedsById.get(item.feedId);
    return {
      ...item,
      platform: itemFeed?.platform ?? "youtube",
    } as ApplicationFeedItem;
  });
}

const lightweightFeedItemColumns = {
  id: feedItems.id,
  feedId: feedItems.feedId,
  contentId: feedItems.contentId,
  title: feedItems.title,
  author: feedItems.author,
  url: feedItems.url,
  thumbnail: feedItems.thumbnail,
  isWatched: feedItems.isWatched,
  isWatchLater: feedItems.isWatchLater,
  progress: feedItems.progress,
  duration: feedItems.duration,
  orientation: feedItems.orientation,
  postedAt: feedItems.postedAt,
  createdAt: feedItems.createdAt,
  updatedAt: feedItems.updatedAt,
  isWatchedUpdatedAt: feedItems.isWatchedUpdatedAt,
  isWatchLaterUpdatedAt: feedItems.isWatchLaterUpdatedAt,
  contentHash: feedItems.contentHash,
  contentSnippet: feedItems.contentSnippet,
};

function mapToLightweightFeedItems(
  items: Array<
    { feedId: number; postedAt: Date; id: string } & Record<string, unknown>
  >,
  feedsById: Map<number, DatabaseFeed>,
): LightweightFeedItem[] {
  return items.map((item) => {
    const itemFeed = feedsById.get(item.feedId);
    return {
      ...item,
      platform: itemFeed?.platform ?? "youtube",
    } as unknown as LightweightFeedItem;
  });
}

/**
 * Same as queryFeedItemsForView but returns lightweight items (no content).
 * contentSnippet is included because large-list / large-grid layouts use it
 * for the description line and we want that visible immediately.
 */
async function queryLightweightItemsForView(
  context: ORPCContext,
  view: ApplicationView,
  params: {
    visibilityFilter: VisibilityFilter;
    feedIds: number[];
    cursor: PaginationCursor | null;
    limit: number;
    feedsById: Map<number, DatabaseFeed>;
    feedCategoriesList: DatabaseFeedCategory[];
    customViewCategoryIds: Set<number>;
    customViews: ApplicationView[];
    applicationFeeds: ApplicationFeed[];
    customViewFeedIds?: Set<number>;
  },
): Promise<{
  items: LightweightFeedItem[];
  hasMore: boolean;
  nextCursor: PaginationCursor;
}> {
  const {
    visibilityFilter,
    feedIds,
    cursor,
    limit,
    feedsById,
    feedCategoriesList,
    customViewCategoryIds,
    customViews,
    applicationFeeds,
    customViewFeedIds,
  } = params;

  const isReadVisibility = visibilityFilter === "read";
  const hasSections =
    !isReadVisibility && view.viewSections && view.viewSections.length > 0;

  let itemsData: Array<
    Omit<typeof feedItems.$inferSelect, "content" | "contentSnippet"> & {
      placement?: number;
    }
  >;

  if (isReadVisibility) {
    const readFilterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter(visibilityFilter),
      buildViewCategoryFilter(
        view,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
        customViewFeedIds,
      ),
      buildContentTypeFilter(view.contentType, applicationFeeds),
      buildTimeWindowFilter(view.daysWindow),
      buildCursorCondition(cursor),
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const readFilter =
      readFilterConditions.length > 0
        ? and(...readFilterConditions)
        : undefined;

    itemsData = await context.db
      .select(lightweightFeedItemColumns)
      .from(feedItems)
      .where(readFilter)
      .orderBy(
        desc(feedItems.isWatchedUpdatedAt),
        desc(feedItems.postedAt),
        desc(feedItems.id),
      )
      .limit(limit + 1);
  } else if (!hasSections) {
    const flatFilterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter(visibilityFilter),
      buildViewCategoryFilter(
        view,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
        customViewFeedIds,
      ),
      buildContentTypeFilter(view.contentType, applicationFeeds),
      buildTimeWindowFilter(view.daysWindow),
      buildCursorCondition(cursor),
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const flatFilter =
      flatFilterConditions.length > 0
        ? and(...flatFilterConditions)
        : undefined;

    itemsData = await context.db
      .select(lightweightFeedItemColumns)
      .from(feedItems)
      .where(flatFilter)
      .orderBy(desc(feedItems.postedAt), desc(feedItems.id))
      .limit(limit + 1);
  } else {
    const placementExpr = buildSectionPlacementExpression(view.id);
    const cursorCondition = buildCursorCondition(cursor, placementExpr);

    const sectionFilterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter(visibilityFilter),
      buildViewCategoryFilter(
        view,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
        customViewFeedIds,
      ),
      buildContentTypeFilter(view.contentType, applicationFeeds),
      buildTimeWindowFilter(view.daysWindow),
      cursorCondition,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const sectionFilter =
      sectionFilterConditions.length > 0
        ? and(...sectionFilterConditions)
        : undefined;

    itemsData = await context.db
      .select({
        ...lightweightFeedItemColumns,
        placement: placementExpr,
      })
      .from(feedItems)
      .where(sectionFilter)
      .orderBy(asc(placementExpr), desc(feedItems.postedAt), desc(feedItems.id))
      .limit(limit + 1);
  }

  const { itemsToReturn, hasMore, nextCursor } = processPaginationResults(
    itemsData,
    limit,
  );

  const lightweightItems = mapToLightweightFeedItems(itemsToReturn, feedsById);

  return {
    items: lightweightItems,
    hasMore,
    nextCursor,
  };
}

/**
 * Shared helper to query feed items for a view with correct ordering based on
 * visibility filter and section configuration.
 *
 * - "read" visibility: orders by isWatchedUpdatedAt (ignores sections)
 * - Non-sectioned views: orders by postedAt
 * - Sectioned views: orders by section placement, then postedAt
 *
 * Queries limit + 1 to determine hasMore, then slices.
 */
async function queryFeedItemsForView(
  context: ORPCContext,
  view: ApplicationView,
  params: {
    visibilityFilter: VisibilityFilter;
    feedIds: number[];
    cursor: PaginationCursor | null;
    limit: number;
    feedsById: Map<number, DatabaseFeed>;
    feedCategoriesList: DatabaseFeedCategory[];
    customViewCategoryIds: Set<number>;
    customViews: ApplicationView[];
    applicationFeeds: ApplicationFeed[];
    customViewFeedIds?: Set<number>;
  },
): Promise<{
  items: ApplicationFeedItem[];
  hasMore: boolean;
  nextCursor: PaginationCursor;
}> {
  const {
    visibilityFilter,
    feedIds,
    cursor,
    limit,
    feedsById,
    feedCategoriesList,
    customViewCategoryIds,
    customViews,
    applicationFeeds,
    customViewFeedIds,
  } = params;

  const isReadVisibility = visibilityFilter === "read";
  const hasSections =
    !isReadVisibility && view.viewSections && view.viewSections.length > 0;

  let itemsData: Array<typeof feedItems.$inferSelect & { placement?: number }>;

  if (isReadVisibility) {
    // Read visibility: sort by when items were marked as read.
    // Subsections (section placement) are not applied, but all other
    // view filters (category, content type, time window) are.
    const filterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter(visibilityFilter),
      buildViewCategoryFilter(
        view,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
        customViewFeedIds,
      ),
      buildContentTypeFilter(view.contentType, applicationFeeds),
      buildTimeWindowFilter(view.daysWindow),
      buildCursorCondition(cursor),
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const filter =
      filterConditions.length > 0 ? and(...filterConditions) : undefined;

    itemsData = await context.db.query.feedItems.findMany({
      where: filter,
      orderBy: [
        desc(feedItems.isWatchedUpdatedAt),
        desc(feedItems.postedAt),
        desc(feedItems.id),
      ],
      limit: limit + 1,
    });
  } else if (!hasSections) {
    // Non-sectioned views: order by date only
    const filterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter(visibilityFilter),
      buildViewCategoryFilter(
        view,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
        customViewFeedIds,
      ),
      buildContentTypeFilter(view.contentType, applicationFeeds),
      buildTimeWindowFilter(view.daysWindow),
      buildCursorCondition(cursor),
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const filter =
      filterConditions.length > 0 ? and(...filterConditions) : undefined;

    itemsData = await context.db.query.feedItems.findMany({
      where: filter,
      orderBy: [desc(feedItems.postedAt), desc(feedItems.id)],
      limit: limit + 1,
    });
  } else {
    // Sectioned views: order by section placement, then date
    const placementExpr = buildSectionPlacementExpression(view.id);
    const cursorCondition = buildCursorCondition(cursor, placementExpr);

    const filterConditions = [
      inArray(feedItems.feedId, feedIds),
      buildVisibilityFilter(visibilityFilter),
      buildViewCategoryFilter(
        view,
        feedCategoriesList,
        feedIds,
        customViewCategoryIds,
        customViews,
        applicationFeeds,
        customViewFeedIds,
      ),
      buildContentTypeFilter(view.contentType, applicationFeeds),
      buildTimeWindowFilter(view.daysWindow),
      cursorCondition,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

    const filter =
      filterConditions.length > 0 ? and(...filterConditions) : undefined;

    itemsData = await context.db
      .select({
        ...getTableColumns(feedItems),
        placement: placementExpr,
      })
      .from(feedItems)
      .where(filter)
      .orderBy(asc(placementExpr), desc(feedItems.postedAt), desc(feedItems.id))
      .limit(limit + 1);
  }

  const { itemsToReturn, hasMore, nextCursor } = processPaginationResults(
    itemsData,
    limit,
  );

  const applicationFeedItems = mapToApplicationFeedItems(
    itemsToReturn,
    feedsById,
  );

  return {
    items: applicationFeedItems,
    hasMore,
    nextCursor,
  };
}

type PreparedApplicationData = {
  customViews: ApplicationView[];
  allViews: ApplicationView[];
  customViewCategoryIds: Set<number>;
  customViewFeedIds: Set<number>;
  applicationFeeds: ApplicationFeed[];
  feedsById: Map<number, DatabaseFeed>;
  feedIds: number[];
};

/**
 * Prepare application data after fetching prerequisites.
 * Builds application views, parses feeds, creates feedsById map.
 */
function prepareApplicationData(
  userId: string,
  prerequisiteData: PrerequisiteData,
): PreparedApplicationData {
  const {
    viewsList,
    feedsList,
    contentCategoriesList,
    viewCategoriesList,
    viewFeedsList,
    viewSectionsList,
  } = prerequisiteData;

  const { customViews, allViews, customViewCategoryIds, customViewFeedIds } =
    buildApplicationViews(
      userId,
      viewsList,
      contentCategoriesList,
      viewCategoriesList,
      viewFeedsList,
      viewSectionsList,
    );

  const applicationFeeds = parseArrayOfSchema(feedsList, feedsSchema);
  const feedsById = new Map(feedsList.map((f) => [f.id, f]));
  const feedIds = feedsList.map((feed) => feed.id);

  return {
    customViews,
    allViews,
    customViewCategoryIds,
    customViewFeedIds,
    applicationFeeds,
    feedsById,
    feedIds,
  };
}

/**
 * Publish prerequisite data chunks (views, feeds, content-categories, feed-categories).
 */
async function publishPrerequisiteDataChunks(
  channel: string,
  source: "initial",
  data: {
    allViews: ApplicationView[];
    applicationFeeds: ApplicationFeed[];
    contentCategoriesList: DatabaseContentCategory[];
    feedCategoriesList: DatabaseFeedCategory[];
  },
): Promise<void> {
  await publisher.publish(channel, {
    source,
    chunk: { type: "views", views: data.allViews },
  });

  await publisher.publish(channel, {
    source,
    chunk: { type: "feeds", feeds: data.applicationFeeds },
  });

  await publisher.publish(channel, {
    source,
    chunk: {
      type: "content-categories",
      contentCategories: data.contentCategoriesList,
    },
  });

  await publisher.publish(channel, {
    source,
    chunk: { type: "feed-categories", feedCategories: data.feedCategoriesList },
  });
}

type PublishViewFeedsResult = {
  feedIdToViewIds?: Map<number, number[]>;
};

/**
 * Publish view-feeds chunks for all views.
 * Optionally builds and returns feedIdToViewIds map.
 */
async function publishViewFeedsChunks(
  channel: string,
  source: "initial",
  params: {
    allViews: ApplicationView[];
    applicationFeeds: ApplicationFeed[];
    feedCategoriesList: DatabaseFeedCategory[];
    customViews: ApplicationView[];
    customViewCategoryIds: Set<number>;
    customViewFeedIds: Set<number>;
    buildFeedIdToViewIds?: boolean;
  },
): Promise<PublishViewFeedsResult> {
  const {
    allViews,
    applicationFeeds,
    feedCategoriesList,
    customViews,
    customViewCategoryIds,
    customViewFeedIds,
    buildFeedIdToViewIds,
  } = params;

  const feedIdToViewIds = buildFeedIdToViewIds
    ? new Map<number, number[]>()
    : undefined;

  const feedCategoriesMap = buildFeedCategoriesMap(feedCategoriesList);

  for (const view of allViews) {
    const feedIdsForView = computeFeedsForView(
      view,
      applicationFeeds,
      feedCategoriesList,
      customViews,
      customViewCategoryIds,
      feedCategoriesMap,
      customViewFeedIds,
    );

    await publisher.publish(channel, {
      source,
      chunk: {
        type: "view-feeds",
        viewId: view.id,
        feedIds: feedIdsForView,
      },
    });

    if (feedIdToViewIds) {
      for (const feedId of feedIdsForView) {
        const existingViewIds = feedIdToViewIds.get(feedId);
        if (existingViewIds) {
          existingViewIds.push(view.id);
        } else {
          feedIdToViewIds.set(feedId, [view.id]);
        }
      }
    }
  }

  return { feedIdToViewIds };
}

// ============================================================================
// SUBSCRIPTION PROCEDURE
// ============================================================================

/**
 * Subscribe to the user's channel to receive real-time data chunks.
 * This creates a long-lived SSE connection.
 */
export const subscribe = protectedProcedure.handler(async function* ({
  context,
  signal,
  lastEventId,
}) {
  const channel = getUserChannel(context.user.id);
  const untrack = trackChannelConnection(channel);

  try {
    const iterator = publisher.subscribe(channel, { signal, lastEventId });

    for await (const payload of iterator) {
      yield payload;
    }
  } finally {
    untrack();
  }
});

// ============================================================================
// REQUEST PROCEDURES (publish instead of yield)
// ============================================================================

/**
 * Request initial data load. Data is published to the user's channel.
 *
 * The client sends a `viewManifests` map of its cached items per view so the
 * server can compute a diff and stream only what changed. If no manifests are
 * provided (fresh client), all items are streamed as "new".
 *
 * Flow:
 *   1. Publish metadata (views, feeds, categories, view-feeds)
 *   2. For each view, query server's correct initial items per visibility
 *      filter and publish a view-diff chunk. Unread is published first,
 *      followed by read/later after initial-data-complete.
 *   3. Publish initial-data-complete (client can show UI)
 *   4. Publish read/later diffs
 *   5. If feeds are due for refresh, call refreshUserFeeds
 */
export const requestInitialData = protectedProcedure.handler(
  async ({ context }) => {
    const channel = getUserChannel(context.user.id);

    // Step 1: Fetch all prerequisite data using helper
    let prerequisiteData: PrerequisiteData;
    try {
      prerequisiteData = await fetchUserPrerequisiteData(context);
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "initial",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch initial data",
          phase: "initial-fetch",
          viewId: -1,
        },
      });
      return { status: "error" };
    }

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=prerequisites-fetched`,
    );

    const { feedsList, contentCategoriesList, feedCategoriesList } =
      prerequisiteData;

    // Build application data using helper
    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=application-data-prepared`,
    );

    // Step 2: Publish prerequisite data chunks
    await publishPrerequisiteDataChunks(channel, "initial", {
      allViews,
      applicationFeeds,
      contentCategoriesList,
      feedCategoriesList,
    });

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=prerequisites-published`,
    );

    // Step 3: Publish view-feeds chunks for each view
    await publishViewFeedsChunks(channel, "initial", {
      allViews,
      applicationFeeds,
      feedCategoriesList,
      customViews,
      customViewCategoryIds,
      customViewFeedIds,
    });

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=view-feeds-published`,
    );

    const firstView = allViews[0];

    if (feedIds.length === 0 || !firstView) {
      await publisher.publish(channel, {
        source: "initial",
        chunk: { type: "initial-data-complete" },
      });
      logDebug(
        `[requestInitialData] user=${context.user.id} phase=early-complete-no-feeds`,
      );
      return { status: "completed" };
    }

    // Helper: query initial lightweight items for a view + visibility.
    async function queryAndPublishLightweightItems(
      view: ApplicationView,
      visibilityFilter: VisibilityFilter,
    ) {
      try {
        const { items, hasMore, nextCursor } =
          await queryLightweightItemsForView(context, view, {
            visibilityFilter,
            feedIds,
            cursor: null,
            limit: INITIAL_ITEMS_PER_VIEW,
            feedsById,
            feedCategoriesList,
            customViewCategoryIds,
            customViews,
            applicationFeeds,
            customViewFeedIds,
          });

        await publisher.publish(channel, {
          source: "initial",
          chunk: {
            type: "view-lightweight-items",
            viewId: view.id,
            visibilityFilter,
            items,
            cursor: nextCursor,
            hasMore,
          },
        });
      } catch (error) {
        captureException(error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logError(
          `[view-lightweight-items] view=${view.id} visibility=${visibilityFilter} error:`,
          errorMessage,
          error,
        );
        await publisher.publish(channel, {
          source: "initial",
          chunk: {
            type: "error",
            message: errorMessage,
            phase: "view-lightweight-items",
            viewId: view.id,
          },
        });
      }
    }

    // Step 4: Publish unread lightweight items for all views (highest priority)
    for (const view of allViews) {
      await queryAndPublishLightweightItems(view, "unread");
    }

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=unread-items-published`,
    );

    // Signal that initial (unread) data is complete — client can show UI
    await publisher.publish(channel, {
      source: "initial",
      chunk: { type: "initial-data-complete" },
    });

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=initial-data-complete-signaled`,
    );

    // Step 5: Publish read and later lightweight items for all views
    for (const view of allViews) {
      await queryAndPublishLightweightItems(view, "read");
      await queryAndPublishLightweightItems(view, "later");
    }

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=read-later-items-published`,
    );

    // Step 6: Check refresh rate limit and publish refresh-start. The
    // cooldown + total feeds are streamed before the slow RSS fetch so the
    // client can show loading state immediately.
    const eligibility = await checkUserRefreshEligibility(
      context.db,
      context.user.id,
    );

    const feedsDue = eligibility.eligible
      ? feedsList.filter(
          (f) => f.isActive && (!f.nextFetchAt || f.nextFetchAt <= new Date()),
        )
      : [];

    await publisher.publish(channel, {
      source: "initial",
      chunk: {
        type: "refresh-start",
        totalFeeds: feedsDue.length,
        nextRefreshAt: eligibility.nextRefreshAt,
      },
    });

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=refresh-start-published feedsDue=${feedsDue.length}`,
    );

    // Step 7: Run RSS fetch if eligible.
    if (eligibility.eligible) {
      await refreshUserFeeds({
        db: context.db,
        feedsList,
        channel,
      });
      logDebug(
        `[requestInitialData] user=${context.user.id} phase=refresh-completed`,
      );
    }

    // Step 8: Always signal completion so the client exits loading state.
    await publisher.publish(channel, {
      source: "initial",
      chunk: { type: "refresh-complete" },
    });

    logDebug(
      `[requestInitialData] user=${context.user.id} phase=refresh-complete-published`,
    );

    return { status: "completed" };
  },
);

/**
 * Request data after importing feeds. Similar to requestInitialData but also
 * streams ALL RSS-fetched items to the client for immediate display.
 * Only fetches RSS for the specified newFeedIds (the newly imported feeds).
 */
export const requestImportedData = protectedProcedure
  .input(z.object({ newFeedIds: z.number().array() }))
  .handler(async ({ context, input }) => {
    const { newFeedIds } = input;
    const channel = getUserChannel(context.user.id);

    // Step 1: Fetch all prerequisite data using helper
    let prerequisiteData: PrerequisiteData;
    try {
      prerequisiteData = await fetchUserPrerequisiteData(context);
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "initial",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch initial data",
          phase: "initial-fetch",
          viewId: -1,
        },
      });
      return { status: "error" };
    }

    const { feedsList, contentCategoriesList, feedCategoriesList } =
      prerequisiteData;

    // Build application data using helper
    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    // Step 2: Publish prerequisite data chunks
    await publishPrerequisiteDataChunks(channel, "initial", {
      allViews,
      applicationFeeds,
      contentCategoriesList,
      feedCategoriesList,
    });

    // Step 3: Publish view-feeds chunks
    await publishViewFeedsChunks(channel, "initial", {
      allViews,
      applicationFeeds,
      feedCategoriesList,
      customViews,
      customViewCategoryIds,
      customViewFeedIds,
      buildFeedIdToViewIds: false,
    });
    const firstView = allViews[0];

    if (feedIds.length === 0 || !firstView) {
      await publisher.publish(channel, {
        source: "initial",
        chunk: { type: "initial-data-complete" },
      });
      return { status: "completed" };
    }

    const fetchContentForViewParams: FetchContentForViewParams = {
      feedIds,
      visibilityFilter: undefined,
      feedCategoriesList,
      customViewCategoryIds,
      customViews,
      applicationFeeds,
      feedsById,
    };

    // Step 4: Query and publish initial items for EACH view
    for await (const { chunk } of fetchContentForViews(
      context,
      allViews,
      fetchContentForViewParams,
    )) {
      await publisher.publish(channel, {
        source: "initial",
        chunk,
      });
    }

    // Signal that initial data is complete - client can hide loading screen
    await publisher.publish(channel, {
      source: "initial",
      chunk: { type: "initial-data-complete" },
    });

    // Step 5: Run fetch and insert for fresh RSS items - ONLY for newly imported feeds
    // Filter feedsList to only include the newly imported feeds
    const newFeedsToFetch = feedsList.filter((feed) =>
      newFeedIds.includes(feed.id),
    );

    for await (const feedResult of fetchAndInsertFeedData(
      context,
      newFeedsToFetch,
    )) {
      await publisher.publish(channel, {
        source: "initial",
        chunk: {
          type: "feed-status",
          status: feedResult.status,
          feedId: feedResult.id,
        },
      });

      // Stream ALL fetched items (unlike requestInitialData which only sends feed-status)
      if (feedResult.status === "success" && feedResult.feedItems.length > 0) {
        await publisher.publish(channel, {
          source: "initial",
          chunk: {
            type: "feed-items",
            feedId: feedResult.id,
            feedItems: feedResult.feedItems,
          },
        });
      }
    }

    return { status: "completed" };
  });

/**
 * Combined streaming import endpoint that inserts feeds and fetches RSS content
 * in a single operation using a worker pool for maximum parallelism.
 * Each feed is processed completely (insert + RSS fetch) before being considered done.
 */
export const streamingImport = protectedProcedure
  .input(
    z.object({
      feeds: z
        .object({
          feedUrl: z.string(),
          categories: z.string().array(),
        })
        .array(),
      importMode: z.enum(["tags", "views", "ignore"]).optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const importMode = input.importMode ?? "tags";
    const channel = getUserChannel(context.user.id);
    const BATCH_SIZE = 4;

    if (!input.feeds.length) {
      await publisher.publish(channel, {
        source: "initial",
        chunk: { type: "initial-data-complete" },
      });
      return { status: "completed" };
    }

    // Check activation budget upfront
    const { remainingSlots, maxActiveFeeds } = await getFeedsActivationBudget(
      context.db,
      context.user.id,
    );
    const deactivatedCount = Math.max(0, input.feeds.length - remainingSlots);

    // Pre-calculate which feeds should be active. Strip categories for any
    // mode other than "tags" — we only want to create category links when
    // the user explicitly chose to import sections as tags. The original
    // categories list is preserved on the side for "views" mode below.
    const feedsWithActivation = input.feeds.map((feed, index) => ({
      feedUrl: feed.feedUrl,
      categories: importMode === "tags" ? feed.categories : [],
      originalCategories: feed.categories,
      shouldBeActive: index < remainingSlots,
    }));

    // Publish import start with total feeds count (must come before
    // import-limit-warning so the client's loading machine is initialized first)
    await publisher.publish(channel, {
      source: "initial",
      chunk: { type: "import-start", totalFeeds: input.feeds.length },
    });

    // Publish warning if some feeds will be inactive
    if (deactivatedCount > 0) {
      await publisher.publish(channel, {
        source: "initial",
        chunk: {
          type: "import-limit-warning",
          deactivatedCount,
          maxActiveFeeds,
        },
      });
    }

    // Track successful feed IDs for building view mappings later
    const successfulFeeds: Array<{
      feedId: number;
      feed: typeof feeds.$inferSelect;
      sectionNames: string[];
    }> = [];

    // Worker function: insert feed + fetch RSS content
    async function processFeed(feedInput: (typeof feedsWithActivation)[0]) {
      const IMPORT_TIMEOUT_MS = 15_000; // 15 seconds

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Import timed out")),
          IMPORT_TIMEOUT_MS,
        );
      });

      const importPromise = (async () => {
        // 1. Insert feed within a transaction (rate-limited)
        const insertResult = await dbSemaphore.run(() =>
          context.db.transaction(async (tx) => {
            return await insertFeedWithCategories(
              tx,
              context.user.id,
              feedInput,
              feedInput.shouldBeActive,
            );
          }),
        );

        if (!insertResult.success) {
          await publisher.publish(channel, {
            source: "initial",
            chunk: {
              type: "import-feed-error",
              feedUrl: feedInput.feedUrl,
              error: insertResult.error,
            },
          });
          return { success: false as const, feedUrl: feedInput.feedUrl };
        }

        // 2. Publish that feed was inserted
        await publisher.publish(channel, {
          source: "initial",
          chunk: {
            type: "import-feed-inserted",
            feedUrl: feedInput.feedUrl,
            feedId: insertResult.feedId,
            feed: insertResult.feed,
          },
        });

        // Track successful feed for later
        successfulFeeds.push({
          feedId: insertResult.feedId,
          feed: insertResult.feed as typeof feeds.$inferSelect,
          sectionNames: feedInput.originalCategories,
        });

        // 3. Immediately fetch RSS content for this feed
        for await (const feedResult of fetchAndInsertFeedData(context, [
          insertResult.feed as typeof feeds.$inferSelect,
        ])) {
          await publisher.publish(channel, {
            source: "initial",
            chunk: {
              type: "feed-status",
              feedId: feedResult.id,
              status: feedResult.status,
            },
          });
        }

        return {
          success: true as const,
          feedUrl: feedInput.feedUrl,
          feedId: insertResult.feedId,
        };
      })();

      try {
        return await Promise.race([importPromise, timeoutPromise]);
      } catch (error) {
        captureException(error);
        await publisher.publish(channel, {
          source: "initial",
          chunk: {
            type: "import-feed-error",
            feedUrl: feedInput.feedUrl,
            error: error instanceof Error ? error.message : "Import timed out",
          },
        });
        return { success: false as const, feedUrl: feedInput.feedUrl };
      }
    }

    // Process all feeds through worker pool
    const workerIterator = workerPool(
      feedsWithActivation,
      BATCH_SIZE,
      processFeed,
    );
    // Consume the iterator - results are published via side effects in processFeed
    while (!(await workerIterator.next()).done) {
      // Results stream as each feed completes
    }

    // For "views" mode: create (or reuse) a view per unique section name and
    // link successfully-imported feeds to those views via the viewFeeds table.
    if (importMode === "views" && successfulFeeds.length > 0) {
      // Derive section order from the original input so OPML ordering is
      // preserved (successfulFeeds is populated in completion order).
      const sectionOrder: string[] = [];
      for (const feed of input.feeds) {
        for (const category of feed.categories) {
          if (category && !sectionOrder.includes(category)) {
            sectionOrder.push(category);
          }
        }
      }

      if (sectionOrder.length > 0) {
        await context.db.transaction(async (tx) => {
          // Look up existing views by name for this user
          const existingViews = await tx
            .select()
            .from(views)
            .where(eq(views.userId, context.user.id));
          const existingByName = new Map(existingViews.map((v) => [v.name, v]));

          // Insert any missing views with default settings
          const namesToCreate = sectionOrder.filter(
            (name) => !existingByName.has(name),
          );
          if (namesToCreate.length > 0) {
            const inserted = await tx
              .insert(views)
              .values(
                namesToCreate.map((name) => ({
                  userId: context.user.id,
                  name,
                  placement:
                    sectionOrder.length - 1 - sectionOrder.indexOf(name),
                })),
              )
              .returning();
            for (const v of inserted) {
              existingByName.set(v.name, v);
            }
          }

          // Build viewFeeds rows
          const viewFeedRows: Array<{ viewId: number; feedId: number }> = [];
          for (const sf of successfulFeeds) {
            for (const name of sf.sectionNames) {
              const view = existingByName.get(name);
              if (!view) continue;
              viewFeedRows.push({ viewId: view.id, feedId: sf.feedId });
            }
          }

          if (viewFeedRows.length > 0) {
            await tx
              .insert(viewFeeds)
              .values(viewFeedRows)
              .onConflictDoNothing();
          }
        });
      }
    }

    // After all feeds complete, publish updated prerequisite data
    const prerequisiteData = await fetchUserPrerequisiteData(context);
    const { contentCategoriesList, feedCategoriesList } = prerequisiteData;

    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    await publishPrerequisiteDataChunks(channel, "initial", {
      allViews,
      applicationFeeds,
      contentCategoriesList,
      feedCategoriesList,
    });

    // Publish view-feeds chunks
    await publishViewFeedsChunks(channel, "initial", {
      allViews,
      applicationFeeds,
      feedCategoriesList,
      customViews,
      customViewCategoryIds,
      customViewFeedIds,
    });

    // Query and publish items for all views (like requestInitialData)
    const fetchContentForViewParams: FetchContentForViewParams = {
      feedIds,
      visibilityFilter: undefined,
      feedCategoriesList,
      customViewCategoryIds,
      customViews,
      applicationFeeds,
      feedsById,
    };

    for await (const { chunk } of fetchContentForViews(
      context,
      allViews,
      fetchContentForViewParams,
    )) {
      await publisher.publish(channel, {
        source: "initial",
        chunk,
      });
    }

    await publisher.publish(channel, {
      source: "initial",
      chunk: { type: "initial-data-complete" },
    });

    return { status: "completed" };
  });

/**
 * Cursor schema for pagination.
 * For sectioned views, placement is included to support ordering by section then date.
 */
const cursorSchema = z
  .object({
    placement: z.number().optional(),
    postedAt: z.coerce.date(),
    id: z.string(),
    isWatchedUpdatedAt: z.coerce.date().nullable().optional(),
  })
  .nullable();

/**
 * Build cursor condition for pagination.
 * Uses composite cursor {postedAt, id} for date-ordered views,
 * and {placement, postedAt, id} for section-ordered views.
 */
function buildCursorCondition(
  cursor: {
    placement?: number;
    postedAt: Date;
    id: string;
    isWatchedUpdatedAt?: Date | null;
  } | null,
  placementColumn?: SQL<number>,
) {
  if (!cursor) return undefined;

  // isWatchedUpdatedAt-based cursor for read visibility filter
  if (cursor.isWatchedUpdatedAt) {
    return or(
      lt(feedItems.isWatchedUpdatedAt, cursor.isWatchedUpdatedAt),
      and(
        eq(feedItems.isWatchedUpdatedAt, cursor.isWatchedUpdatedAt),
        lt(feedItems.postedAt, cursor.postedAt),
      ),
      and(
        eq(feedItems.isWatchedUpdatedAt, cursor.isWatchedUpdatedAt),
        eq(feedItems.postedAt, cursor.postedAt),
        lt(feedItems.id, cursor.id),
      ),
    );
  }

  // Date-only cursor (legacy or non-sectioned views)
  if (!placementColumn || cursor.placement === undefined) {
    return or(
      lt(feedItems.postedAt, cursor.postedAt),
      and(eq(feedItems.postedAt, cursor.postedAt), lt(feedItems.id, cursor.id)),
    );
  }

  // Section-aware cursor: (placement > cursor.placement)
  //   OR (placement = cursor.placement AND postedAt < cursor.postedAt)
  //   OR (placement = cursor.placement AND postedAt = cursor.postedAt AND id < cursor.id)
  return or(
    gt(placementColumn, cursor.placement),
    and(
      eq(placementColumn, cursor.placement),
      lt(feedItems.postedAt, cursor.postedAt),
    ),
    and(
      eq(placementColumn, cursor.placement),
      eq(feedItems.postedAt, cursor.postedAt),
      lt(feedItems.id, cursor.id),
    ),
  );
}

/**
 * Build a SQL expression that returns the minimum section placement for a feed item.
 * Uncategorized items (not in any section) get placement 999999.
 */
function buildSectionPlacementExpression(viewId: number): SQL<number> {
  // Drizzle serializes ${feedItems.feedId} as unqualified "feed_id" inside
  // sql template subqueries, which resolves to the innermost table
  // (feed_categories.feed_id) instead of the outer feed_item.feed_id.
  // Build a raw qualified reference so both SELECT and ORDER BY contexts
  // consistently reference serial_feed_item.feed_id.
  const tableName = (feedItems as unknown as Record<symbol, string>)[
    Symbol.for("drizzle:Name")
  ];
  const colName = (feedItems.feedId as unknown as { name: string }).name;
  const feedIdRef = sql.raw(`"${tableName}"."${colName}"`);

  return sql<number>`COALESCE((
    SELECT MIN(placement)
    FROM serial_view_sections
    WHERE view_id = ${viewId}
      AND (
        (item_type = 'feed' AND item_id = ${feedIdRef})
        OR (
          item_type = 'tag'
          AND EXISTS (
            SELECT 1 FROM serial_feed_categories
            WHERE feed_id = ${feedIdRef}
              AND category_id = serial_view_sections.item_id
          )
        )
      )
  ), 999999)`;
}

/**
 * Request items for a specific visibility filter with cursor-based pagination.
 * Used for lazy loading "read" and "later" visibility filters,
 * and for infinite scroll pagination.
 */
export const requestItemsByVisibility = protectedProcedure
  .input(
    z.object({
      viewId: z.number(),
      visibilityFilter: visibilityFilterSchema,
      cursor: cursorSchema.optional(),
      limit: z.number().min(1).max(500).optional(),
      clientItems: z
        .array(
          z.object({
            id: z.string(),
            contentHash: z.string().nullable(),
          }),
        )
        .optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const channel = getUserChannel(context.user.id);
    const limit = input.limit ?? ITEMS_PER_PAGE;
    const clientItems = input.clientItems;

    // Fetch prerequisite data using helper
    let prerequisiteData: PrerequisiteData;
    try {
      prerequisiteData = await fetchUserPrerequisiteData(context);
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "visibility",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch initial data",
          phase: "initial-fetch",
        },
      });
      return { status: "error" };
    }

    const { feedCategoriesList } = prerequisiteData;

    // Build application data using helper
    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    if (feedIds.length === 0) {
      await publisher.publish(channel, {
        source: "visibility",
        chunk: {
          type: "view-diff",
          viewId: input.viewId,
          visibilityFilter: input.visibilityFilter,
          diff: [],
          cursor: null,
          hasMore: false,
        },
      });
      return { status: "completed" };
    }

    // Find target view (INBOX_VIEW_ID maps to the Uncategorized view)
    const targetView = allViews.find((v) => v.id === input.viewId);

    if (!targetView) {
      await publisher.publish(channel, {
        source: "visibility",
        chunk: {
          type: "error",
          message: `View with ID ${input.viewId} not found`,
          phase: "find-view",
        },
      });
      return { status: "error" };
    }

    try {
      const { items, hasMore, nextCursor } = await queryFeedItemsForView(
        context,
        targetView,
        {
          visibilityFilter: input.visibilityFilter,
          feedIds,
          cursor: input.cursor ?? null,
          limit,
          feedsById,
          feedCategoriesList,
          customViewCategoryIds,
          customViews,
          applicationFeeds,
          customViewFeedIds,
        },
      );

      // Always use diff-based response
      const diff = computeViewDiff(items, clientItems ?? []);

      await publisher.publish(channel, {
        source: "visibility",
        chunk: {
          type: "view-diff",
          viewId: input.viewId,
          visibilityFilter: input.visibilityFilter,
          diff,
          cursor: nextCursor,
          hasMore,
        },
      });
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "visibility",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : `Failed to fetch items for view ${input.viewId}`,
          phase: "feed-items",
        },
      });
      return { status: "error" };
    }

    return { status: "completed" };
  });

/**
 * Request items for a specific feed with cursor-based pagination.
 * Used for lazy loading when a feed is selected in the sidebar.
 */
export const requestItemsByFeed = protectedProcedure
  .input(
    z.object({
      feedId: z.number(),
      visibilityFilter: visibilityFilterSchema,
      cursor: cursorSchema.optional(),
      limit: z.number().min(1).max(500).optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const channel = getUserChannel(context.user.id);
    const limit = input.limit ?? ITEMS_PER_PAGE;

    // Verify feed belongs to user
    const feed = await context.db.query.feeds.findFirst({
      where: and(eq(feeds.id, input.feedId), eq(feeds.userId, context.user.id)),
    });

    if (!feed) {
      await publisher.publish(channel, {
        source: "feed",
        chunk: {
          type: "error",
          message: `Feed with ID ${input.feedId} not found or does not belong to user`,
          phase: "verify-feed",
        },
      });
      return { status: "error" };
    }

    try {
      // Build filter conditions
      const filterConditions = [
        eq(feedItems.feedId, input.feedId),
        buildVisibilityFilter(input.visibilityFilter),
        buildCursorCondition(input.cursor ?? null),
      ].filter((f): f is NonNullable<typeof f> => f !== undefined);

      const filter =
        filterConditions.length > 0 ? and(...filterConditions) : undefined;

      // Query limit + 1 to determine if there are more items
      const itemsData = await context.db.query.feedItems.findMany({
        where: filter,
        orderBy: desc(feedItems.postedAt),
        limit: limit + 1,
      });

      // Process pagination results using helper
      const { itemsToReturn, hasMore, nextCursor } = processPaginationResults(
        itemsData,
        limit,
      );

      // Map items with single feed's platform (no lookup needed)
      const applicationFeedItems = itemsToReturn.map((item) => ({
        ...item,
        platform: feed.platform,
      })) as ApplicationFeedItem[];

      // Publish items in chunks for large result sets
      for (const chunk of prepareArrayChunks(
        applicationFeedItems,
        GET_BY_VIEW_CHUNK_SIZE,
      )) {
        await publisher.publish(channel, {
          source: "feed",
          chunk: {
            type: "feed-items",
            feedId: input.feedId,
            feedItems: chunk,
            visibilityFilter: input.visibilityFilter,
            hasMore,
            nextCursor,
          },
        });
      }

      // If no items, still publish an empty response
      if (applicationFeedItems.length === 0) {
        await publisher.publish(channel, {
          source: "feed",
          chunk: {
            type: "feed-items",
            feedId: input.feedId,
            feedItems: [],
            visibilityFilter: input.visibilityFilter,
            hasMore: false,
            nextCursor: null,
          },
        });
      }
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "feed",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : `Failed to fetch items for feed ${input.feedId}`,
          phase: "feed-items",
        },
      });
      return { status: "error" };
    }

    return { status: "completed" };
  });

/**
 * Request items for feeds in a specific category with cursor-based pagination.
 * Used for lazy loading when a category is selected in the sidebar.
 */
export const requestItemsByCategoryId = protectedProcedure
  .input(
    z.object({
      categoryId: z.number(),
      visibilityFilter: visibilityFilterSchema,
      cursor: cursorSchema.optional(),
      limit: z.number().min(1).max(500).optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    const channel = getUserChannel(context.user.id);
    const limit = input.limit ?? ITEMS_PER_PAGE;

    // Verify category belongs to user
    const category = await context.db.query.contentCategories.findFirst({
      where: and(
        eq(contentCategories.id, input.categoryId),
        eq(contentCategories.userId, context.user.id),
      ),
    });

    if (!category) {
      await publisher.publish(channel, {
        source: "category",
        chunk: {
          type: "error",
          message: `Category with ID ${input.categoryId} not found or does not belong to user`,
          phase: "verify-category",
        },
      });
      return { status: "error" };
    }

    // Get feed IDs in this category
    const categoryFeedLinks = await context.db
      .select()
      .from(feedCategories)
      .where(eq(feedCategories.categoryId, input.categoryId));

    const feedIdsInCategory = categoryFeedLinks.map((fc) => fc.feedId);

    if (feedIdsInCategory.length === 0) {
      await publisher.publish(channel, {
        source: "category",
        chunk: {
          type: "feed-items",
          categoryId: input.categoryId,
          feedItems: [],
          visibilityFilter: input.visibilityFilter,
          hasMore: false,
          nextCursor: null,
        },
      });
      return { status: "completed" };
    }

    // Fetch feeds for platform lookup
    const feedsList = await context.db.query.feeds.findMany({
      where: and(
        inArray(feeds.id, feedIdsInCategory),
        eq(feeds.userId, context.user.id),
      ),
    });

    const feedsById = new Map(feedsList.map((f) => [f.id, f]));

    try {
      // Build filter conditions
      const filterConditions = [
        inArray(feedItems.feedId, feedIdsInCategory),
        buildVisibilityFilter(input.visibilityFilter),
        buildCursorCondition(input.cursor ?? null),
      ].filter((f): f is NonNullable<typeof f> => f !== undefined);

      const filter =
        filterConditions.length > 0 ? and(...filterConditions) : undefined;

      // Query limit + 1 to determine if there are more items
      const itemsData = await context.db.query.feedItems.findMany({
        where: filter,
        orderBy: desc(feedItems.postedAt),
        limit: limit + 1,
      });

      // Process pagination results using helper
      const { itemsToReturn, hasMore, nextCursor } = processPaginationResults(
        itemsData,
        limit,
      );

      // Map to application feed items using helper
      const applicationFeedItems = mapToApplicationFeedItems(
        itemsToReturn,
        feedsById,
      );

      // Publish items in chunks for large result sets
      for (const chunk of prepareArrayChunks(
        applicationFeedItems,
        GET_BY_VIEW_CHUNK_SIZE,
      )) {
        await publisher.publish(channel, {
          source: "category",
          chunk: {
            type: "feed-items",
            categoryId: input.categoryId,
            feedItems: chunk,
            visibilityFilter: input.visibilityFilter,
            hasMore,
            nextCursor,
          },
        });
      }

      // If no items, still publish an empty response
      if (applicationFeedItems.length === 0) {
        await publisher.publish(channel, {
          source: "category",
          chunk: {
            type: "feed-items",
            categoryId: input.categoryId,
            feedItems: [],
            visibilityFilter: input.visibilityFilter,
            hasMore: false,
            nextCursor: null,
          },
        });
      }
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "category",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : `Failed to fetch items for category ${input.categoryId}`,
          phase: "feed-items",
        },
      });
      return { status: "error" };
    }

    return { status: "completed" };
  });

// ============================================================================
// LEGACY STREAMING PROCEDURES (kept for backward compatibility during migration)
// ============================================================================

export const getAllByView = protectedProcedure
  .input(z.object({ visibilityFilter: visibilityFilterSchema }).optional())
  .handler(async function* ({ context, input }) {
    const visibilityFilter = input?.visibilityFilter;
    const isVisibilityFilterFetch = !!visibilityFilter;

    // Step 1: Fetch all prerequisite data using helper
    let prerequisiteData: PrerequisiteData;
    try {
      prerequisiteData = await fetchUserPrerequisiteData(context);
    } catch (error) {
      captureException(error);
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to fetch initial data",
        phase: "initial-fetch",
      } as GetByViewChunk;
      return;
    }

    const { feedsList, contentCategoriesList, feedCategoriesList } =
      prerequisiteData;

    // Build application data using helper
    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    // Step 2: Yield prerequisite data chunks (skip when fetching for visibility filter)
    if (!isVisibilityFilterFetch) {
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

      yield {
        type: "feed-categories",
        feedCategories: feedCategoriesList,
      } as GetByViewChunk;

      // Step 3: Yield view-feeds chunks for each view
      const feedCategoriesMap = buildFeedCategoriesMap(feedCategoriesList);
      for (const view of allViews) {
        const feedIdsForView = computeFeedsForView(
          view,
          applicationFeeds,
          feedCategoriesList,
          customViews,
          customViewCategoryIds,
          feedCategoriesMap,
          customViewFeedIds,
        );

        yield {
          type: "view-feeds",
          viewId: view.id,
          feedIds: feedIdsForView,
        } as GetByViewChunk;
      }
    }

    const firstView = allViews[0];

    if (feedIds.length === 0 || !firstView) {
      if (!isVisibilityFilterFetch) {
        yield { type: "initial-data-complete" } as GetByViewChunk;
      }
      return;
    }

    const fetchContentForViewParams: FetchContentForViewParams = {
      feedIds,
      visibilityFilter,
      feedCategoriesList,
      customViewCategoryIds,
      customViews,
      applicationFeeds,
      feedsById,
    };

    // Step 4: Query and yield initial items (first 100) for EACH view
    for await (const { chunk } of fetchContentForViews(
      context,
      allViews,
      fetchContentForViewParams,
    )) {
      yield chunk;
    }

    // Skip initial-data-complete and RSS fetch when fetching for visibility filter
    if (!isVisibilityFilterFetch) {
      // Signal that initial data is complete - client can hide loading screen
      yield { type: "initial-data-complete" } as GetByViewChunk;

      // Step 5: Run fetch and insert for fresh RSS items in background
      // Items are inserted to DB by fetchAndInsertFeedData - don't yield them here
      // Fresh items will be available via pagination (getItemsByVisibility)
      const activeFeedsForLegacy = feedsList.filter((feed) => feed.isActive);
      for await (const feedResult of fetchAndInsertFeedData(
        context,
        activeFeedsForLegacy,
      )) {
        yield {
          type: "feed-status",
          status: feedResult.status,
          feedId: feedResult.id,
        } as GetByViewChunk;
        // Items already inserted to DB - they'll be included in pagination queries
      }
    }

    return;
  });

export const revalidateView = protectedProcedure
  .input(z.object({ viewId: z.number() }))
  .handler(async function* ({ context, input }) {
    // Step 1: Fetch all prerequisite data using helper
    let prerequisiteData: PrerequisiteData;
    try {
      prerequisiteData = await fetchUserPrerequisiteData(context);
    } catch (error) {
      captureException(error);
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

    const { feedCategoriesList } = prerequisiteData;

    // Build application data using helper
    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    // Find uncategorized view (always present in allViews with id === INBOX_VIEW_ID)
    const uncategorizedView = allViews.find((v) => v.id === INBOX_VIEW_ID)!;

    // Step 2: Yield views
    yield {
      type: "views",
      views: allViews,
    } as RevalidateViewChunk;

    // Step 3: Yield view-feeds chunks for each view
    const feedCategoriesMap = buildFeedCategoriesMap(feedCategoriesList);
    for (const view of allViews) {
      const feedIdsForView = computeFeedsForView(
        view,
        applicationFeeds,
        feedCategoriesList,
        customViews,
        customViewCategoryIds,
        feedCategoriesMap,
        customViewFeedIds,
      );

      yield {
        type: "view-feeds",
        viewId: view.id,
        feedIds: feedIdsForView,
      } as RevalidateViewChunk;
    }

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

    // Helper function to query and yield feed items for a view (limited for pagination)
    async function* queryAndYieldFeedItemsForView(
      view: ApplicationView,
    ): AsyncGenerator<RevalidateViewChunk> {
      try {
        const { items } = await queryFeedItemsForView(context, view, {
          visibilityFilter: "unread",
          feedIds,
          cursor: null,
          limit: REVALIDATE_VIEW_CHUNK_SIZE,
          feedsById,
          feedCategoriesList,
          customViewCategoryIds,
          customViews,
          applicationFeeds,
        });

        yield {
          type: "feed-items",
          viewId: view.id,
          feedItems: items,
        } as RevalidateViewChunk;
      } catch (error) {
        captureException(error);
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

export type GetItemsByVisibilityChunk =
  | {
      type: "feed-items";
      viewId: number;
      feedItems: ApplicationFeedItem[];
      visibilityFilter: string;
      hasMore: boolean;
      nextCursor: PaginationCursor;
    }
  | {
      type: "view-diff";
      viewId: number;
      visibilityFilter: string;
      diff: DiffEntry[];
      cursor: PaginationCursor;
      hasMore: boolean;
    }
  | { type: "error"; message: string; phase: string };

export type GetItemsByFeedChunk =
  | {
      type: "feed-items";
      feedId: number;
      feedItems: ApplicationFeedItem[];
      visibilityFilter: string;
      hasMore: boolean;
      nextCursor: PaginationCursor;
    }
  | { type: "error"; message: string; phase: string };

export type GetItemsByCategoryIdChunk =
  | {
      type: "feed-items";
      categoryId: number;
      feedItems: ApplicationFeedItem[];
      visibilityFilter: string;
      hasMore: boolean;
      nextCursor: PaginationCursor;
    }
  | { type: "error"; message: string; phase: string };

/**
 * Fetch items for a specific visibility filter with cursor-based pagination.
 * Used for lazy loading "read" and "later" visibility filters,
 * and for infinite scroll pagination.
 */
export const getItemsByVisibility = protectedProcedure
  .input(
    z.object({
      viewId: z.number(),
      visibilityFilter: visibilityFilterSchema,
      cursor: cursorSchema.optional(),
      limit: z.number().min(1).max(500).optional(),
    }),
  )
  .handler(async function* ({ context, input }) {
    const limit = input.limit ?? ITEMS_PER_PAGE;

    // Fetch prerequisite data using helper
    let prerequisiteData: PrerequisiteData;
    try {
      prerequisiteData = await fetchUserPrerequisiteData(context);
    } catch (error) {
      captureException(error);
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Failed to fetch initial data",
        phase: "initial-fetch",
      } as GetItemsByVisibilityChunk;
      return;
    }

    const { feedCategoriesList } = prerequisiteData;

    // Build application data using helper
    const {
      customViews,
      allViews,
      customViewCategoryIds,
      customViewFeedIds,
      applicationFeeds,
      feedsById,
      feedIds,
    } = prepareApplicationData(context.user.id, prerequisiteData);

    if (feedIds.length === 0) {
      yield {
        type: "feed-items",
        viewId: input.viewId,
        feedItems: [],
        visibilityFilter: input.visibilityFilter,
        hasMore: false,
        nextCursor: null,
      } as GetItemsByVisibilityChunk;
      return;
    }

    // Find target view (INBOX_VIEW_ID maps to the Uncategorized view which is in allViews)
    const targetView = allViews.find((v) => v.id === input.viewId);

    if (!targetView) {
      yield {
        type: "error",
        message: `View with ID ${input.viewId} not found`,
        phase: "find-view",
      } as GetItemsByVisibilityChunk;
      return;
    }

    try {
      const isReadVisibility = input.visibilityFilter === "read";
      const hasSections =
        !isReadVisibility &&
        targetView.viewSections &&
        targetView.viewSections.length > 0;

      let itemsData: Array<
        typeof feedItems.$inferSelect & { placement?: number }
      >;

      if (isReadVisibility) {
        // Read visibility: sort by when items were marked as read.
        // Subsections (section placement) are not applied, but all other
        // view filters (category, content type, time window) are.
        const filterConditions = [
          inArray(feedItems.feedId, feedIds),
          buildVisibilityFilter(input.visibilityFilter),
          buildViewCategoryFilter(
            targetView,
            feedCategoriesList,
            feedIds,
            customViewCategoryIds,
            customViews,
            applicationFeeds,
            customViewFeedIds,
          ),
          buildContentTypeFilter(targetView.contentType, applicationFeeds),
          buildTimeWindowFilter(targetView.daysWindow),
          buildCursorCondition(input.cursor ?? null),
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);

        const filter =
          filterConditions.length > 0 ? and(...filterConditions) : undefined;

        itemsData = await context.db.query.feedItems.findMany({
          where: filter,
          orderBy: [
            desc(feedItems.isWatchedUpdatedAt),
            desc(feedItems.postedAt),
            desc(feedItems.id),
          ],
          limit: limit + 1,
        });
      } else if (!hasSections) {
        // Non-sectioned views: order by date only
        const filterConditions = [
          inArray(feedItems.feedId, feedIds),
          buildVisibilityFilter(input.visibilityFilter),
          buildViewCategoryFilter(
            targetView,
            feedCategoriesList,
            feedIds,
            customViewCategoryIds,
            customViews,
            applicationFeeds,
            customViewFeedIds,
          ),
          buildContentTypeFilter(targetView.contentType, applicationFeeds),
          buildTimeWindowFilter(targetView.daysWindow),
          buildCursorCondition(input.cursor ?? null),
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);

        const filter =
          filterConditions.length > 0 ? and(...filterConditions) : undefined;

        itemsData = await context.db.query.feedItems.findMany({
          where: filter,
          orderBy: desc(feedItems.postedAt),
          limit: limit + 1,
        });
      } else {
        // Sectioned views: order by section placement, then date
        const placementExpr = buildSectionPlacementExpression(targetView.id);
        const cursorCondition = buildCursorCondition(
          input.cursor ?? null,
          placementExpr,
        );

        const filterConditions = [
          inArray(feedItems.feedId, feedIds),
          buildVisibilityFilter(input.visibilityFilter),
          buildViewCategoryFilter(
            targetView,
            feedCategoriesList,
            feedIds,
            customViewCategoryIds,
            customViews,
            applicationFeeds,
            customViewFeedIds,
          ),
          buildContentTypeFilter(targetView.contentType, applicationFeeds),
          buildTimeWindowFilter(targetView.daysWindow),
          cursorCondition,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);

        const filter =
          filterConditions.length > 0 ? and(...filterConditions) : undefined;

        itemsData = await context.db
          .select({
            ...getTableColumns(feedItems),
            placement: placementExpr,
          })
          .from(feedItems)
          .where(filter)
          .orderBy(
            asc(placementExpr),
            desc(feedItems.postedAt),
            desc(feedItems.id),
          )
          .limit(limit + 1);
      }

      // Process pagination results using helper
      const { itemsToReturn, hasMore, nextCursor } = processPaginationResults(
        itemsData,
        limit,
      );

      // Map to application feed items using helper
      const applicationFeedItems = mapToApplicationFeedItems(
        itemsToReturn,
        feedsById,
      );

      // Yield items in chunks for large result sets
      for (const chunk of prepareArrayChunks(
        applicationFeedItems,
        ITEMS_BY_VISIBILITY_CHUNK_SIZE,
      )) {
        yield {
          type: "feed-items",
          viewId: input.viewId,
          feedItems: chunk,
          visibilityFilter: input.visibilityFilter,
          hasMore,
          nextCursor,
        } as GetItemsByVisibilityChunk;
      }

      // If no items, still yield an empty response
      if (applicationFeedItems.length === 0) {
        yield {
          type: "feed-items",
          viewId: input.viewId,
          feedItems: [],
          visibilityFilter: input.visibilityFilter,
          hasMore: false,
          nextCursor: null,
        } as GetItemsByVisibilityChunk;
      }
    } catch (error) {
      captureException(error);
      yield {
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : `Failed to fetch items for view ${input.viewId}`,
        phase: "feed-items",
      } as GetItemsByVisibilityChunk;
    }
  });

/**
 * Fetch fulltext content for a list of items.
 * Used by the client after receiving lightweight items to fill in missing content.
 * Publishes chunks to the user's SSE channel so the client receives them via
 * the existing subscription.
 */
export const requestFullTextForItems = protectedProcedure
  .input(
    z.object({
      itemIds: z.array(z.string()).max(500),
    }),
  )
  .handler(async ({ context, input }) => {
    const channel = getUserChannel(context.user.id);

    try {
      const items = await context.db
        .select({
          id: feedItems.id,
          content: feedItems.content,
          contentSnippet: feedItems.contentSnippet,
        })
        .from(feedItems)
        .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
        .where(
          and(
            inArray(feedItems.id, input.itemIds),
            eq(feeds.userId, context.user.id),
          ),
        );

      await publisher.publish(channel, {
        source: "initial",
        chunk: {
          type: "fulltext-items",
          items,
        } as GetByViewChunk,
      });

      return { status: "completed" };
    } catch (error) {
      captureException(error);
      await publisher.publish(channel, {
        source: "initial",
        chunk: {
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch fulltext items",
          phase: "fulltext",
        } as GetByViewChunk,
      });
      return { status: "error" };
    }
  });

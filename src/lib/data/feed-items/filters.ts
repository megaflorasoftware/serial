import { and, eq, gte, inArray, ne } from "drizzle-orm";

import { INBOX_VIEW_ID } from "../views/constants";
import type { SQL } from "drizzle-orm";
import type { VisibilityFilter } from "../atoms";
import type {
  ApplicationView,
  DatabaseFeed,
  DatabaseFeedCategory,
} from "~/server/db/schema";
import { feedItems } from "~/server/db/schema";

/** Video platforms that support orientation filtering */
const VIDEO_PLATFORMS = ["youtube", "peertube", "nebula"] as const;

/**
 * Build a Drizzle filter condition for visibility (unread/read/later)
 *
 * - "unread": items that are not watched AND not watch later
 * - "read": items that are watched AND not watch later
 * - "later": items that are marked as watch later
 */
export function buildVisibilityFilter(
  visibilityFilter: VisibilityFilter,
): SQL | undefined {
  switch (visibilityFilter) {
    case "unread":
      return and(
        eq(feedItems.isWatched, false),
        eq(feedItems.isWatchLater, false),
      );
    case "read":
      return and(
        eq(feedItems.isWatched, true),
        eq(feedItems.isWatchLater, false),
      );
    case "later":
      return eq(feedItems.isWatchLater, true);
    default:
      return undefined;
  }
}

/**
 * Build a Drizzle filter condition for category filtering
 *
 * Filters items to only those whose feedId is in the specified category.
 * If categoryFilter < 0, no filter is applied.
 */
export function buildCategoryFilter(
  categoryFilter: number,
  feedCategories: DatabaseFeedCategory[],
): SQL | undefined {
  if (categoryFilter < 0) {
    return undefined;
  }

  const feedIdsInCategory = feedCategories
    .filter((fc) => fc.categoryId === categoryFilter)
    .map((fc) => fc.feedId);

  if (feedIdsInCategory.length === 0) {
    // No feeds in this category - return a condition that matches nothing
    // Using feedId = -1 since IDs are auto-increment positive integers
    return eq(feedItems.feedId, -1);
  }

  return inArray(feedItems.feedId, feedIdsInCategory);
}

/**
 * Build a Drizzle filter condition for feed filtering
 *
 * Filters items to only those from a specific feed.
 * If feedFilter < 0, no filter is applied.
 */
export function buildFeedFilter(feedFilter: number): SQL | undefined {
  if (feedFilter < 0) {
    return undefined;
  }

  return eq(feedItems.feedId, feedFilter);
}

/**
 * Build a Drizzle filter condition for view category filtering
 *
 * For the Inbox view: includes feeds that either match the view's categories
 * OR have no categories at all (uncategorized feeds), but EXCLUDES any feeds
 * that belong to categories assigned to custom views.
 *
 * For regular views: includes only feeds that match the view's categories.
 */
export function buildViewCategoryFilter(
  viewFilter: ApplicationView | null,
  feedCategories: DatabaseFeedCategory[],
  allFeedIds: number[],
  customViewCategoryIds?: Set<number>,
): SQL | undefined {
  if (!viewFilter || viewFilter.categoryIds.length === 0) {
    return undefined;
  }

  // Get feed IDs that are in any of the view's categories
  const feedsForView = feedCategories
    .filter((fc) => viewFilter.categoryIds.includes(fc.categoryId))
    .map((fc) => fc.feedId);

  // For Inbox view, also include uncategorized feeds, but exclude feeds in custom views
  if (viewFilter.id === INBOX_VIEW_ID) {
    const categorizedFeedIds = new Set(feedCategories.map((fc) => fc.feedId));
    const uncategorizedFeedIds = allFeedIds.filter(
      (id) => !categorizedFeedIds.has(id),
    );

    // Exclude feeds that belong to any category assigned to a custom view
    const feedsInCustomViews = new Set(
      feedCategories
        .filter((fc) => customViewCategoryIds?.has(fc.categoryId))
        .map((fc) => fc.feedId),
    );

    const allIncludedFeedIds = [
      ...new Set([...feedsForView, ...uncategorizedFeedIds]),
    ].filter((id) => !feedsInCustomViews.has(id));

    if (allIncludedFeedIds.length === 0) {
      return eq(feedItems.feedId, -1);
    }

    return inArray(feedItems.feedId, allIncludedFeedIds);
  }

  // Regular view - only include feeds in the view's categories
  if (feedsForView.length === 0) {
    return eq(feedItems.feedId, -1);
  }

  return inArray(feedItems.feedId, feedsForView);
}

/**
 * Build a Drizzle filter condition for content type filtering
 *
 * Content types:
 * - "all": no filter
 * - "longform": exclude vertical orientation items
 * - "horizontal-video": only video feeds with horizontal orientation
 * - "vertical-video": only video feeds with vertical orientation
 */
export function buildContentTypeFilter(
  contentType: string | undefined,
  feeds: DatabaseFeed[],
): SQL | undefined {
  if (!contentType || contentType === "all") {
    return undefined;
  }

  // Get IDs of feeds that are video platforms
  const videoFeedIds = feeds
    .filter((feed) =>
      VIDEO_PLATFORMS.includes(feed.platform as (typeof VIDEO_PLATFORMS)[number]),
    )
    .map((feed) => feed.id);

  switch (contentType) {
    case "longform":
      // Exclude vertical videos (shorts)
      return ne(feedItems.orientation, "vertical");

    case "horizontal-video":
      // Must be from a video feed AND have horizontal orientation
      if (videoFeedIds.length === 0) {
        return eq(feedItems.feedId, -1);
      }
      return and(
        inArray(feedItems.feedId, videoFeedIds),
        eq(feedItems.orientation, "horizontal"),
      );

    case "vertical-video":
      // Must be from a video feed AND have vertical orientation
      if (videoFeedIds.length === 0) {
        return eq(feedItems.feedId, -1);
      }
      return and(
        inArray(feedItems.feedId, videoFeedIds),
        eq(feedItems.orientation, "vertical"),
      );

    default:
      return undefined;
  }
}

/**
 * Build a Drizzle filter condition for time window filtering
 *
 * Filters items to only those posted within the last N days.
 * If daysWindow is 0 or undefined, no filter is applied (all time).
 */
export function buildTimeWindowFilter(
  daysWindow: number | undefined,
): SQL | undefined {
  if (!daysWindow || daysWindow <= 0) {
    return undefined;
  }

  const now = new Date();
  const cutoffDate = new Date(now);
  cutoffDate.setDate(cutoffDate.getDate() - daysWindow);

  return gte(feedItems.postedAt, cutoffDate);
}

/**
 * Parameters for building combined feed item filters
 */
export interface BuildFeedItemFiltersParams {
  visibilityFilter: VisibilityFilter;
  categoryFilter: number;
  feedFilter: number;
  viewFilter: ApplicationView | null;
  feedCategories: DatabaseFeedCategory[];
  feeds: DatabaseFeed[];
  customViewCategoryIds?: Set<number>;
}

/**
 * Build combined Drizzle filter conditions for feed items
 *
 * Combines all individual filters into a single SQL condition using AND.
 * Returns undefined if no filters apply.
 */
export function buildFeedItemFilters(
  params: BuildFeedItemFiltersParams,
): SQL | undefined {
  const {
    visibilityFilter,
    categoryFilter,
    feedFilter,
    viewFilter,
    feedCategories,
    feeds,
    customViewCategoryIds,
  } = params;

  const allFeedIds = feeds.map((feed) => feed.id);

  // Build all individual filters
  const filters: Array<SQL | undefined> = [
    buildVisibilityFilter(visibilityFilter),
    buildCategoryFilter(categoryFilter, feedCategories),
    buildFeedFilter(feedFilter),
    buildViewCategoryFilter(viewFilter, feedCategories, allFeedIds, customViewCategoryIds),
    buildContentTypeFilter(viewFilter?.contentType, feeds),
    buildTimeWindowFilter(viewFilter?.daysWindow),
  ];

  // Filter out undefined values
  const activeFilters = filters.filter((f): f is SQL => f !== undefined);

  if (activeFilters.length === 0) {
    return undefined;
  }

  if (activeFilters.length === 1) {
    return activeFilters[0];
  }

  return and(...activeFilters);
}

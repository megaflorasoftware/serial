import { useAtomValue } from "jotai";
import {
  categoryFilterAtom,
  dateFilterAtom,
  feedFilterAtom,
  viewFilterAtom,
  visibilityFilterAtom,
} from "../atoms";
import { feedItemsStore } from "../store";
import { useFeedCategories } from "../feed-categories/store";
import { useFeeds } from "../feeds/store";
import { INBOX_VIEW_ID } from "../views";
import type { VisibilityFilter } from "../atoms";
import type {
  ApplicationFeedItem,
  ApplicationView,
  DatabaseFeed,
  DatabaseFeedCategory,
} from "~/server/db/schema";

function isVideoContent(item: ApplicationFeedItem): boolean {
  const videoPlatforms = ["youtube", "peertube", "nebula"];
  return videoPlatforms.includes(item.platform);
}

export function doesFeedItemPassFilters(
  item: ApplicationFeedItem,
  dateFilter: number,
  visibilityFilter: VisibilityFilter,
  categoryFilter: number,
  feedCategories: DatabaseFeedCategory[],
  feedFilter: number,
  feeds: DatabaseFeed[],
  viewFilter: ApplicationView | null,
) {
  // Visibility filter
  if (visibilityFilter === "unread" && (item.isWatched || item.isWatchLater)) {
    return false;
  }
  if (visibilityFilter === "read" && (!item.isWatched || item.isWatchLater)) {
    return false;
  }
  if (visibilityFilter === "later" && !item.isWatchLater) {
    return false;
  }

  // if (visibilityFilter === "shorts" && item.orientation !== "vertical") {
  //   return false;
  // }
  // if (visibilityFilter !== "shorts" && item.orientation === "vertical") {
  //   return false;
  // }

  // Category filter
  const feedIdsInCategory = feedCategories
    .filter((category) => category.categoryId === categoryFilter)
    .map((category) => category.feedId);
  if (categoryFilter >= 0 && !feedIdsInCategory.includes(item.feedId)) {
    return false;
  }

  // Feed filter
  if (feedFilter >= 0 && item.feedId !== feedFilter) {
    return false;
  }

  const feedsForView = feedCategories
    .filter((category) => viewFilter?.categoryIds.includes(category.categoryId))
    .map((category) => category.feedId);

  // View filter
  const doesFeedHaveAnyCategories = feedCategories.some(
    (category) => category.feedId === item.feedId,
  );
  if (viewFilter?.id === INBOX_VIEW_ID && !doesFeedHaveAnyCategories) {
    return true;
  }

  if (
    !!viewFilter &&
    viewFilter.categoryIds.length > 0 &&
    !feedsForView.includes(item.feedId)
  ) {
    return false;
  }

  // Content type filter (from view)
  if (viewFilter?.contentType) {
    const ct = viewFilter.contentType;
    if (ct === "longform" && item.orientation === "vertical") {
      return false;
    }
    if (ct === "horizontal-video") {
      // Must be video content AND horizontal orientation
      if (!isVideoContent(item) || item.orientation !== "horizontal") {
        return false;
      }
    }
    if (ct === "vertical-video") {
      // Must be video content AND vertical orientation
      if (!isVideoContent(item) || item.orientation !== "vertical") {
        return false;
      }
    }
    // "all" passes through
  }

  // Time window filter (from view)
  // 0 means "All time", so skip filtering
  if (viewFilter?.daysWindow && viewFilter.daysWindow > 0) {
    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setDate(cutoffDate.getDate() - viewFilter.daysWindow);

    if (item.postedAt < cutoffDate) {
      return false;
    }
  }

  return true;
}

export const useFilteredFeedItemsOrder = () => {
  const dateFilter = useAtomValue(dateFilterAtom);
  const visibilityFilter = useAtomValue(visibilityFilterAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const feedItemsOrder = feedItemsStore.useFeedItemsOrder();
  const feedItemsDict = feedItemsStore.useFeedItemsDict();
  const feedCategories = useFeedCategories();
  const feedFilter = useAtomValue(feedFilterAtom);
  const feeds = useFeeds();
  const viewFilter = useAtomValue(viewFilterAtom);

  return feedItemsOrder.filter((id) => {
    return (
      feedItemsDict[id] &&
      doesFeedItemPassFilters(
        feedItemsDict[id],
        dateFilter,
        visibilityFilter,
        categoryFilter,
        feedCategories,
        feedFilter,
        feeds,
        viewFilter,
      )
    );
  });
};

export function useDoesFeedItemMatchAllFilters(item: ApplicationFeedItem) {
  const dateFilter = useAtomValue(dateFilterAtom);
  const visibilityFilter = useAtomValue(visibilityFilterAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const feedCategories = useFeedCategories();
  const feedFilter = useAtomValue(feedFilterAtom);
  const feeds = useFeeds();
  const viewFilter = useAtomValue(viewFilterAtom);

  return doesFeedItemPassFilters(
    item,
    dateFilter,
    visibilityFilter,
    categoryFilter,
    feedCategories,
    feedFilter,
    feeds,
    viewFilter,
  );
}

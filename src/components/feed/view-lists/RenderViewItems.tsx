"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { EmptyState, FeedEmptyState } from "./EmptyStates";
import {
  GridSkeleton,
  LargeGridSkeleton,
  LargeListSkeleton,
  StandardListSkeleton,
} from "./skeletons";
import { ViewItemGrid } from "./ViewItemGrid";
import { ViewItemLargeGrid } from "./ViewItemLargeGrid";
import { ViewItemLargeList } from "./ViewItemLargeList";
import { ViewItemStandardList } from "./ViewItemStandardList";
import { useViewSections } from "./useViewSections";
import type { ViewSection } from "./useViewSections";
import FeedLoading from "~/components/loading";
import { useLoadMoreItems } from "~/lib/hooks/useLoadMoreItems";
import { viewFilterAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import { useFeedCategories } from "~/lib/data/feed-categories";
import { useFeeds } from "~/lib/data/feeds";
import { useFilteredFeedItemsOrder } from "~/lib/data/feed-items";
import { useBulkSetWatchedValueMutation } from "~/lib/data/feed-items/mutations";
import {
  feedItemsStore,
  useFetchFeedItemsLastFetchedAt,
  useHasInitialData,
} from "~/lib/data/store";
import { VIEW_LAYOUT } from "~/server/db/constants";
import { useFeedItemNavigation } from "~/lib/hooks/useFeedItemNavigation";
import { useShortcut } from "~/lib/hooks/useShortcut";
import { SHORTCUT_KEYS } from "~/lib/constants/shortcuts";
import { showUndoToast } from "~/lib/undo";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";

function SectionHeading({
  name,
  itemType,
  itemId,
  sectionItems,
}: {
  name: string;
  itemType?: "feed" | "tag";
  itemId?: number;
  sectionItems: string[];
}) {
  const { feeds } = useFeeds();
  const visibilityFilter = useAtomValue(visibilityFilterAtom);
  const feedItemsDict = feedItemsStore.useFeedItemsDict();
  const [isLoading, setIsLoading] = useState(false);
  const [isStuck, setIsStuck] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const bulkMutation = useBulkSetWatchedValueMutation();

  useEffect(() => {
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsStuck(!entry?.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, []);

  const handleMarkSectionAsRead = async () => {
    if (visibilityFilter !== "unread" || sectionItems.length === 0) return;

    setIsLoading(true);
    try {
      const items = sectionItems
        .map((id) => ({
          id,
          feedId: feedItemsDict[id]?.feedId ?? 0,
        }))
        .filter((item) => item.feedId > 0);

      if (items.length === 0) return;

      await bulkMutation.mutateAsync({ items, isWatched: true });

      showUndoToast({
        message: `Marked ${items.length} item${items.length === 1 ? "" : "s"} as read`,
        onUndo: async () => {
          await bulkMutation.mutateAsync({ items, isWatched: false });
        },
      });
    } finally {
      setIsLoading(false);
    }
  };

  useShortcut(SHORTCUT_KEYS.MARK_SECTION_READ, handleMarkSectionAsRead);

  return (
    <>
      <div ref={sentinelRef} />
      <div
        className={`bg-background sticky top-0 z-30 border-b pt-4 pb-2 transition-[border-color] ${
          isStuck ? "border-border" : "border-transparent"
        }`}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6">
          {itemType === "feed" &&
            itemId !== undefined &&
            (() => {
              const feed = feeds.find((f) => f.id === itemId);
              if (feed?.imageUrl) {
                return (
                  <img
                    src={feed.imageUrl}
                    alt={feed.name}
                    className="h-6 w-6 rounded object-contain"
                  />
                );
              }
              return <div className="bg-muted-foreground/20 h-6 w-6 rounded" />;
            })()}
          {itemType === "tag" && (
            <div className="bg-muted text-muted-foreground flex h-6 w-6 items-center justify-center rounded text-xs font-medium">
              #
            </div>
          )}
          <h2 className="text-lg font-semibold">{name}</h2>
          <div className="flex-1" />
          {visibilityFilter === "unread" && sectionItems.length > 0 && (
            <ButtonWithShortcut
              variant="outline"
              size="sm"
              onClick={handleMarkSectionAsRead}
              disabled={isLoading}
              className="gap-1.5 text-xs"
              shortcut={SHORTCUT_KEYS.MARK_SECTION_READ}
            >
              <CheckIcon size={14} />
              Mark section as read
            </ButtonWithShortcut>
          )}
        </div>
      </div>
    </>
  );
}

function LayoutSection({
  section,
  handleMouseSelect,
}: {
  section: ViewSection;
  handleMouseSelect: (itemId: string) => void;
}) {
  const { items, layout, startIndex, name, isUncategorized, itemType, itemId } =
    section;

  const layoutProps = {
    items,
    handleMouseSelect,
    startIndex,
    showPaginationEnd: isUncategorized,
    sectionItemType: itemType,
  };

  return (
    <div className="w-full">
      {items.length > 0 && (
        <SectionHeading
          name={isUncategorized ? "Uncategorized" : name}
          itemType={itemType}
          itemId={itemId}
          sectionItems={items}
        />
      )}
      {items.length > 0 && (
        <>
          {layout === VIEW_LAYOUT.LARGE_LIST && (
            <ViewItemLargeList {...layoutProps} />
          )}
          {layout === VIEW_LAYOUT.GRID && <ViewItemGrid {...layoutProps} />}
          {layout === VIEW_LAYOUT.LARGE_GRID && (
            <ViewItemLargeGrid {...layoutProps} />
          )}
          {layout === VIEW_LAYOUT.LIST && (
            <ViewItemStandardList {...layoutProps} />
          )}
        </>
      )}
    </div>
  );
}

export function RenderViewItems() {
  const { feeds, hasFetchedFeeds } = useFeeds();
  const { hasFetchedFeedCategories } = useFeedCategories();

  const feedItemsLastFetchedAt = useFetchFeedItemsLastFetchedAt();
  const hasInitialData = useHasInitialData();

  const filteredFeedItemsOrder = useFilteredFeedItemsOrder();

  const currentView = useAtomValue(viewFilterAtom);

  const {
    hasSubviews,
    computedSections,
    flatItems,
    hasGridSections,
    sectionInfo,
    baseLayout,
  } = useViewSections(currentView, filteredFeedItemsOrder);

  // Keyboard navigation
  const { handleMouseSelect } = useFeedItemNavigation(
    flatItems,
    hasGridSections,
    sectionInfo,
  );

  const { paginationState } = useLoadMoreItems();

  if (!hasInitialData) {
    return <FeedLoading />;
  }

  if (hasFetchedFeeds && !feeds.length) {
    return <FeedEmptyState />;
  }

  // Show skeletons while feed items are being fetched
  if (feedItemsLastFetchedAt === null && filteredFeedItemsOrder.length === 0) {
    switch (baseLayout) {
      case VIEW_LAYOUT.LARGE_LIST:
        return <LargeListSkeleton />;
      case VIEW_LAYOUT.GRID:
        return <GridSkeleton />;
      case VIEW_LAYOUT.LARGE_GRID:
        return <LargeGridSkeleton />;
      default:
        return <StandardListSkeleton />;
    }
  }

  if (
    hasFetchedFeeds &&
    feedItemsLastFetchedAt !== null &&
    hasFetchedFeedCategories &&
    !filteredFeedItemsOrder.length
  ) {
    return <EmptyState />;
  }

  // Non-sectioned rendering (existing behavior)
  if (!hasSubviews) {
    switch (baseLayout) {
      case VIEW_LAYOUT.LARGE_LIST:
        return (
          <ViewItemLargeList
            items={filteredFeedItemsOrder}
            handleMouseSelect={handleMouseSelect}
          />
        );
      case VIEW_LAYOUT.GRID:
        return (
          <ViewItemGrid
            items={filteredFeedItemsOrder}
            handleMouseSelect={handleMouseSelect}
          />
        );
      case VIEW_LAYOUT.LARGE_GRID:
        return (
          <ViewItemLargeGrid
            items={filteredFeedItemsOrder}
            handleMouseSelect={handleMouseSelect}
          />
        );
      default:
        return (
          <ViewItemStandardList
            items={filteredFeedItemsOrder}
            handleMouseSelect={handleMouseSelect}
          />
        );
    }
  }

  // Sectioned rendering
  return (
    <div className="w-full">
      {computedSections.map((section, index) => (
        <LayoutSection
          key={
            section.isUncategorized
              ? "uncategorized"
              : `${section.name}-${index}`
          }
          section={section}
          handleMouseSelect={handleMouseSelect}
        />
      ))}
      {paginationState?.isFetching && (
        <div className="px-4 py-4">
          <StandardListSkeleton />
        </div>
      )}
    </div>
  );
}

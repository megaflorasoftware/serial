"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useAtomValue } from "jotai";
import { GridItemDisplay } from "./ItemDisplay";
import { viewFilterAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import { useFetchMoreItems, useViewPaginationState } from "~/lib/data/store";
import { useInfiniteScroll } from "~/lib/hooks/useInfiniteScroll";
import { useLazyFeedFilter } from "~/lib/hooks/useLazyFeedFilter";
import { useLazyCategoryFilter } from "~/lib/hooks/useLazyCategoryFilter";
import { INITIAL_ITEMS_PER_VIEW } from "~/server/api/constants";

interface ViewItemLargeGridProps {
  items: string[];
}

export function ViewItemLargeGrid({ items }: ViewItemLargeGridProps) {
  const [parent] = useAutoAnimate();

  // Lazy load items when feed or category filter changes
  useLazyFeedFilter();
  useLazyCategoryFilter();

  const currentView = useAtomValue(viewFilterAtom);
  const visibilityFilter = useAtomValue(visibilityFilterAtom);
  const viewPaginationState = useViewPaginationState();
  const fetchMoreItems = useFetchMoreItems();

  const viewId = currentView?.id;
  const paginationState = viewId
    ? viewPaginationState[viewId]?.[visibilityFilter]
    : undefined;

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: () => {
      if (viewId) {
        fetchMoreItems(viewId, visibilityFilter);
      }
    },
    hasMore: paginationState?.hasMore ?? false,
    isLoading: paginationState?.isFetching ?? false,
  });

  const sentinelIndex = Math.max(
    Math.floor(items.length - (INITIAL_ITEMS_PER_VIEW - 10)),
    10,
  );

  return (
    <div className="w-full">
      <div
        ref={parent}
        className="grid w-full gap-4 px-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(250px,_1fr))]"
      >
        {items.map((contentId, index) => (
          <div key={contentId}>
            <GridItemDisplay contentId={contentId} size="large" />
            {index === sentinelIndex && <div ref={sentinelRef} />}
          </div>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useAtomValue } from "jotai";
import { ItemDisplay } from "./ItemDisplay";
import { viewFilterAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import { useFetchMoreItems, useViewPaginationState } from "~/lib/data/store";
import { useInfiniteScroll } from "~/lib/hooks/useInfiniteScroll";
import { useLazyFeedFilter } from "~/lib/hooks/useLazyFeedFilter";
import { useLazyCategoryFilter } from "~/lib/hooks/useLazyCategoryFilter";

interface ViewItemLargeListProps {
  items: string[];
}

export function ViewItemLargeList({ items }: ViewItemLargeListProps) {
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

  return (
    <div className="w-full transition-all md:pt-4 md:pr-6 md:pl-4" ref={parent}>
      {items.map((contentId) => (
        <div key={contentId}>
          <ItemDisplay contentId={contentId} size="large" />
        </div>
      ))}
      <div ref={sentinelRef} />
    </div>
  );
}

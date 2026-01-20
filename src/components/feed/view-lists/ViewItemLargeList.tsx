"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import { ItemDisplay } from "./ItemDisplay";
import { viewFilterAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import { useFetchMoreItems, useViewPaginationState } from "~/lib/data/store";
import { useInfiniteScroll } from "~/lib/hooks/useInfiniteScroll";

interface ViewItemLargeListProps {
  items: string[];
}

export function ViewItemLargeList({ items }: ViewItemLargeListProps) {
  const [parent] = useAutoAnimate();

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

  // Calculate position for sentinel (at 70% of items)
  const sentinelPosition = Math.floor(items.length * 0.7);

  return (
    <div className="w-full transition-all md:pt-4 md:pr-6 md:pl-4" ref={parent}>
      {items.map((contentId, index) => (
        <div key={contentId}>
          <ItemDisplay contentId={contentId} size="large" />
          {index === sentinelPosition && <div ref={sentinelRef} />}
        </div>
      ))}
      {paginationState?.isFetching && (
        <div className="flex justify-center py-4">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      )}
    </div>
  );
}

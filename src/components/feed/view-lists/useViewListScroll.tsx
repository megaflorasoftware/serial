import { useCallback } from "react";
import { useInfiniteScroll } from "~/lib/hooks/useInfiniteScroll";
import { useItemWindow } from "~/lib/hooks/useItemWindow";
import { useLoadMoreItems } from "~/lib/hooks/useLoadMoreItems";
import { ITEMS_PER_PAGE } from "~/server/api/constants";

export function useViewListScroll(itemIds: string[]) {
  const { visibleItems, expandWindow, renderCount } = useItemWindow(itemIds);
  const { handleLoadMore, paginationState } = useLoadMoreItems();

  const handleLoadMoreWithCache = useCallback(() => {
    if (renderCount < itemIds.length) {
      // More cached items available — expand window without server fetch
      expandWindow();
    } else {
      // Exhausted cached items — fetch from server
      handleLoadMore();
    }
  }, [renderCount, itemIds.length, expandWindow, handleLoadMore]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMoreWithCache,
    hasMore:
      renderCount < itemIds.length || (paginationState?.hasMore ?? false),
    isLoading: paginationState?.isFetching ?? false,
  });

  const sentinelIndex = Math.max(
    Math.floor(visibleItems.length - ITEMS_PER_PAGE / 2),
    10,
  );

  return { sentinelRef, sentinelIndex, paginationState, visibleItems };
}

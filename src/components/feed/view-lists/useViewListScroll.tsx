import { useCallback, useEffect, useRef } from "react";
import { useInfiniteScroll } from "~/lib/hooks/useInfiniteScroll";
import { useItemWindow } from "~/lib/hooks/useItemWindow";
import { useLoadMoreItems } from "~/lib/hooks/useLoadMoreItems";

export function useViewListScroll(itemIds: string[]) {
  const { visibleItems, expandWindow, renderCount } = useItemWindow(itemIds);
  const { handleLoadMore, paginationKey, paginationState } = useLoadMoreItems();
  const openValidationKeyRef = useRef<string | null>(null);

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
    rootMargin: "600px 0px",
  });

  const hasRenderedAllItems = renderCount >= itemIds.length;
  const hasMoreItems = paginationState?.hasMore === true;
  const isFetchingMoreItems = paginationState?.isFetching === true;
  const shouldValidatePaginationWhenCacheIsExhausted =
    hasRenderedAllItems && hasMoreItems && !isFetchingMoreItems;

  useEffect(() => {
    if (!shouldValidatePaginationWhenCacheIsExhausted) return;

    const firstItemId = itemIds[0];
    const openValidationKey = `${paginationKey}:${firstItemId}`;
    if (openValidationKeyRef.current === openValidationKey) return;

    openValidationKeyRef.current = openValidationKey;
    handleLoadMore();
  }, [
    handleLoadMore,
    itemIds,
    paginationKey,
    shouldValidatePaginationWhenCacheIsExhausted,
  ]);

  return {
    sentinelRef,
    paginationState,
    visibleItems,
    hasRenderedAllItems,
  };
}

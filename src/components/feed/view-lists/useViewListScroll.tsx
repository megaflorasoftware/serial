import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteScroll } from "~/lib/hooks/useInfiniteScroll";
import { useItemWindow } from "~/lib/hooks/useItemWindow";
import { useLoadMoreItems } from "~/lib/hooks/useLoadMoreItems";

type PendingServerExpansion = {
  id: number;
  itemCountBeforeFetch: number;
  isComplete: boolean;
};

export function useViewListScroll(itemIds: string[]) {
  const { visibleItems, expandWindow, renderCount } = useItemWindow(itemIds);
  const { handleLoadMore, paginationKey, paginationState } = useLoadMoreItems();
  const openValidationKeyRef = useRef<string | null>(null);
  const nextServerLoadIdRef = useRef(0);
  const handledServerExpansionIdRef = useRef<number | null>(null);
  const [pendingServerExpansion, setPendingServerExpansion] =
    useState<PendingServerExpansion | null>(null);

  const loadMoreFromServer = useCallback(() => {
    const serverLoadId = nextServerLoadIdRef.current + 1;
    nextServerLoadIdRef.current = serverLoadId;

    setPendingServerExpansion({
      id: serverLoadId,
      itemCountBeforeFetch: itemIds.length,
      isComplete: false,
    });

    void handleLoadMore().finally(() => {
      setPendingServerExpansion((pendingExpansion) => {
        if (pendingExpansion?.id !== serverLoadId) {
          return pendingExpansion;
        }

        return { ...pendingExpansion, isComplete: true };
      });
    });
  }, [handleLoadMore, itemIds.length]);

  const handleLoadMoreWithCache = useCallback(() => {
    if (renderCount < itemIds.length) {
      // More cached items available — expand window without server fetch
      expandWindow(itemIds.length);
    } else {
      // Exhausted cached items — fetch from server
      loadMoreFromServer();
    }
  }, [renderCount, itemIds.length, expandWindow, loadMoreFromServer]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: handleLoadMoreWithCache,
    hasMore:
      renderCount < itemIds.length || (paginationState?.hasMore ?? false),
    isLoading: paginationState?.isFetching ?? false,
    rootMargin: "600px 0px",
  });

  useEffect(() => {
    if (!pendingServerExpansion) return;
    if (handledServerExpansionIdRef.current === pendingServerExpansion.id) {
      return;
    }

    const hasReceivedServerItems =
      itemIds.length > pendingServerExpansion.itemCountBeforeFetch;
    const hasSettledWithoutMoreItems =
      pendingServerExpansion.isComplete && paginationState?.isFetching !== true;

    if (hasReceivedServerItems || hasSettledWithoutMoreItems) {
      handledServerExpansionIdRef.current = pendingServerExpansion.id;
      expandWindow(itemIds.length);
    }
  }, [expandWindow, itemIds.length, paginationState, pendingServerExpansion]);

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
    loadMoreFromServer();
  }, [
    itemIds,
    loadMoreFromServer,
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

"use client";

import { useAtomValue } from "jotai";
import { ItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { VisibleItemTracker } from "./VisibleItemTracker";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";
import { useDeferredAutoAnimate } from "~/lib/hooks/useDeferredAutoAnimate";

interface ViewItemLargeListProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  startIndex?: number;
  sentinelRef?:
    | React.RefObject<HTMLDivElement | null>
    | ((node: HTMLDivElement | null) => void);
  sentinelIndex?: number;
  showPaginationEnd?: boolean;
}

export function ViewItemLargeList({
  items,
  handleMouseSelect,
  startIndex = 0,
  sentinelRef,
  sentinelIndex,
  showPaginationEnd = true,
}: ViewItemLargeListProps) {
  const [parent] = useDeferredAutoAnimate();
  const selectedItemId = useAtomValue(selectedItemIdAtom);

  const {
    sentinelRef: defaultSentinelRef,
    sentinelIndex: defaultSentinelIndex,
    paginationState,
  } = useViewListScroll(items);

  const actualSentinelRef = sentinelRef ?? defaultSentinelRef;
  const actualSentinelIndex =
    (sentinelIndex ?? defaultSentinelIndex) + startIndex;

  return (
    <div
      className="mx-auto w-full max-w-3xl transition-all md:pt-2"
      ref={parent}
    >
      {items.map((contentId, index) => {
        const globalIndex = startIndex + index;
        return (
          <VisibleItemTracker key={contentId} itemId={contentId}>
            <ItemDisplay
              contentId={contentId}
              size="large"
              isSelected={contentId === selectedItemId}
              onSelect={
                handleMouseSelect
                  ? () => handleMouseSelect(contentId)
                  : undefined
              }
            />
            {globalIndex === actualSentinelIndex && (
              <div ref={actualSentinelRef} key={globalIndex} />
            )}
          </VisibleItemTracker>
        );
      })}
      {paginationState?.isFetching && <PaginationLoader />}
      {showPaginationEnd && !paginationState?.hasMore && <PaginationEnd />}
    </div>
  );
}

"use client";

import { useAtomValue } from "jotai";
import { ItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { ViewListContainer } from "./ViewListContainer";
import { VisibleItemTracker } from "./VisibleItemTracker";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";

interface ViewItemLargeListProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  startIndex?: number;
  showPaginationEnd?: boolean;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemLargeList({
  items,
  handleMouseSelect,
  startIndex = 0,
  showPaginationEnd = true,
  sectionItemType,
}: ViewItemLargeListProps) {
  const selectedItemId = useAtomValue(selectedItemIdAtom);

  const { sentinelRef, sentinelIndex, paginationState, visibleItems } =
    useViewListScroll(items);

  const actualSentinelIndex = sentinelIndex + startIndex;

  return (
    <ViewListContainer>
      <div className="transition-all md:pt-2">
        {visibleItems.map((contentId, index) => {
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
                sectionItemType={sectionItemType}
              />
              {globalIndex === actualSentinelIndex && (
                <div ref={sentinelRef} key={globalIndex} />
              )}
            </VisibleItemTracker>
          );
        })}
        {paginationState?.isFetching && <PaginationLoader />}
        {showPaginationEnd && !paginationState?.hasMore && <PaginationEnd />}
      </div>
    </ViewListContainer>
  );
}

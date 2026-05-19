"use client";

import { useAtomValue } from "jotai";
import { GridItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { ViewListContainer } from "./ViewListContainer";
import { VisibleItemTracker } from "./VisibleItemTracker";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";

interface ViewItemLargeGridProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  startIndex?: number;
  showPaginationEnd?: boolean;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemLargeGrid({
  items,
  handleMouseSelect,
  startIndex = 0,
  showPaginationEnd = true,
  sectionItemType,
}: ViewItemLargeGridProps) {
  const selectedItemId = useAtomValue(selectedItemIdAtom);

  const { sentinelRef, sentinelIndex, paginationState, visibleItems } =
    useViewListScroll(items);

  const actualSentinelIndex = sentinelIndex + startIndex;

  return (
    <ViewListContainer className="px-4">
      <div className="grid w-full items-stretch gap-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(250px,_1fr))]">
        {visibleItems.map((contentId, index) => {
          const globalIndex = startIndex + index;
          return (
            <VisibleItemTracker key={contentId} itemId={contentId}>
              <GridItemDisplay
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
      </div>
      {paginationState?.isFetching && <PaginationLoader />}
      {showPaginationEnd && !paginationState?.hasMore && <PaginationEnd />}
    </ViewListContainer>
  );
}

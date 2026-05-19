"use client";

import { useAtomValue } from "jotai";
import { GridItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { ViewListContainer } from "./ViewListContainer";
import { VisibleItemTracker } from "./VisibleItemTracker";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";

interface ViewItemGridProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  startIndex?: number;
  sentinelRef?:
    | React.RefObject<HTMLDivElement | null>
    | ((node: HTMLDivElement | null) => void);
  sentinelIndex?: number;
  showPaginationEnd?: boolean;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemGrid({
  items,
  handleMouseSelect,
  startIndex = 0,
  sentinelRef,
  sentinelIndex,
  showPaginationEnd = true,
  sectionItemType,
}: ViewItemGridProps) {
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
    <ViewListContainer className="px-4">
      <div className="grid w-full grid-cols-2 items-stretch gap-y-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(180px,_1fr))] md:gap-2">
        {items.map((contentId, index) => {
          const globalIndex = startIndex + index;
          return (
            <VisibleItemTracker key={contentId} itemId={contentId}>
              <GridItemDisplay
                contentId={contentId}
                size="standard"
                isSelected={contentId === selectedItemId}
                onSelect={
                  handleMouseSelect
                    ? () => handleMouseSelect(contentId)
                    : undefined
                }
                sectionItemType={sectionItemType}
              />
              {globalIndex === actualSentinelIndex && (
                <div ref={actualSentinelRef} key={globalIndex} />
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

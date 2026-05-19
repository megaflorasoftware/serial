"use client";

import { useAtomValue } from "jotai";
import { ItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { ViewListContainer } from "./ViewListContainer";
import { VisibleItemTracker } from "./VisibleItemTracker";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";

interface ViewItemStandardListProps {
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

export function ViewItemStandardList({
  items,
  handleMouseSelect,
  startIndex = 0,
  sentinelRef,
  sentinelIndex,
  showPaginationEnd = true,
  sectionItemType,
}: ViewItemStandardListProps) {
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
    <ViewListContainer>
      <div className="transition-all md:pt-2">
        {items.map((contentId, index) => {
          const globalIndex = startIndex + index;
          return (
            <VisibleItemTracker key={contentId} itemId={contentId}>
              <ItemDisplay
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
        {paginationState?.isFetching && <PaginationLoader />}
        {showPaginationEnd && !paginationState?.hasMore && <PaginationEnd />}
      </div>
    </ViewListContainer>
  );
}

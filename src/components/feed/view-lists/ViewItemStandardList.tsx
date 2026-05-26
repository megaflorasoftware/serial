"use client";

import { useAtomValue } from "jotai";
import { Fragment } from "react";
import { ItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { ViewListContainer } from "./ViewListContainer";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";
import { useDeferredAutoAnimate } from "~/lib/hooks/useDeferredAutoAnimate";

interface ViewItemStandardListProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  startIndex?: number;
  showPaginationEnd?: boolean;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemStandardList({
  items,
  handleMouseSelect,
  startIndex = 0,
  showPaginationEnd = true,
  sectionItemType,
}: ViewItemStandardListProps) {
  const selectedItemId = useAtomValue(selectedItemIdAtom);
  const [parent] = useDeferredAutoAnimate<HTMLDivElement>();

  const { sentinelRef, sentinelIndex, paginationState, visibleItems } =
    useViewListScroll(items);

  const actualSentinelIndex = sentinelIndex + startIndex;

  return (
    <ViewListContainer>
      <div ref={parent} className="transition-all md:pt-2">
        {visibleItems.map((contentId, index) => {
          const globalIndex = startIndex + index;
          return (
            <Fragment key={contentId}>
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
                <div ref={sentinelRef} key={globalIndex} />
              )}
            </Fragment>
          );
        })}
        {paginationState?.isFetching && <PaginationLoader />}
        {showPaginationEnd && !paginationState?.hasMore && <PaginationEnd />}
      </div>
    </ViewListContainer>
  );
}

"use client";

import { useAtomValue } from "jotai";
import { Fragment } from "react";
import { GridItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { ViewListContainer } from "./ViewListContainer";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";
import { useDeferredAutoAnimate } from "~/lib/hooks/useDeferredAutoAnimate";

interface ViewItemGridProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  startIndex?: number;
  showPaginationEnd?: boolean;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemGrid({
  items,
  handleMouseSelect,
  startIndex = 0,
  showPaginationEnd = true,
  sectionItemType,
}: ViewItemGridProps) {
  const selectedItemId = useAtomValue(selectedItemIdAtom);
  const [parent] = useDeferredAutoAnimate<HTMLDivElement>();

  const { sentinelRef, sentinelIndex, paginationState, visibleItems } =
    useViewListScroll(items);

  const actualSentinelIndex = sentinelIndex + startIndex;

  return (
    <ViewListContainer className="px-4">
      <div
        ref={parent}
        className="grid w-full grid-cols-2 items-stretch gap-y-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(180px,_1fr))] md:gap-2"
      >
        {visibleItems.map((contentId, index) => {
          const globalIndex = startIndex + index;
          return (
            <Fragment key={contentId}>
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
                <div ref={sentinelRef} key={globalIndex} />
              )}
            </Fragment>
          );
        })}
      </div>
      {paginationState?.isFetching && <PaginationLoader />}
      {showPaginationEnd && !paginationState?.hasMore && <PaginationEnd />}
    </ViewListContainer>
  );
}

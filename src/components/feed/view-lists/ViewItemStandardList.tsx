"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useAtom } from "jotai";
import { ItemDisplay } from "./ItemDisplay";
import { PaginationEnd } from "./PaginationEnd";
import { PaginationLoader } from "./PaginationLoader";
import { VisibleItemTracker } from "./VisibleItemTracker";
import { useViewListScroll } from "./useViewListScroll";
import { selectedItemIdAtom } from "~/lib/data/atoms";

interface ViewItemStandardListProps {
  items: string[];
}

export function ViewItemStandardList({ items }: ViewItemStandardListProps) {
  const [parent] = useAutoAnimate();
  const [selectedItemId, setSelectedItemId] = useAtom(selectedItemIdAtom);

  const { sentinelRef, sentinelIndex, paginationState } =
    useViewListScroll(items);

  return (
    <div className="w-full transition-all md:pt-4 md:pr-6 md:pl-4" ref={parent}>
      {items.map((contentId, index) => (
        <VisibleItemTracker key={contentId} index={index}>
          <ItemDisplay
            contentId={contentId}
            size="standard"
            isSelected={contentId === selectedItemId}
            onSelect={() => setSelectedItemId(contentId)}
          />
          {index === sentinelIndex && (
            <div ref={sentinelRef} key={sentinelIndex} />
          )}
        </VisibleItemTracker>
      ))}
      {paginationState?.isFetching && <PaginationLoader />}
      {!paginationState?.hasMore && <PaginationEnd />}
    </div>
  );
}

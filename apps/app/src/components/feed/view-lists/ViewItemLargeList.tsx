"use client";

import { useAtomValue } from "jotai";
import { FlipItem } from "./FlipItem";
import { SelectableItemDisplay } from "./SelectableItemDisplay";
import { ViewListContainer } from "./ViewListContainer";
import { selectedItemIdAtom } from "~/lib/data/atoms";
import { useFlipItems } from "~/lib/hooks/useFlipItems";

interface ViewItemLargeListProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemLargeList({
  items,
  handleMouseSelect,
  sectionItemType,
}: ViewItemLargeListProps) {
  const selectedItemId = useAtomValue(selectedItemIdAtom);
  const { renderedItems, containerRef } = useFlipItems(items);

  return (
    <ViewListContainer>
      <div ref={containerRef} className="relative md:pt-2">
        {renderedItems.map((contentId) => (
          <FlipItem key={contentId} id={contentId}>
            <SelectableItemDisplay
              contentId={contentId}
              size="large"
              isSelected={contentId === selectedItemId}
              onSelectItem={handleMouseSelect}
              sectionItemType={sectionItemType}
            />
          </FlipItem>
        ))}
      </div>
    </ViewListContainer>
  );
}

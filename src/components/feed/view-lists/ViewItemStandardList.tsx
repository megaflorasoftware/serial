"use client";

import { useAtomValue } from "jotai";
import { Fragment } from "react";
import { ItemDisplay } from "./ItemDisplay";
import { ViewListContainer } from "./ViewListContainer";
import { selectedItemIdAtom } from "~/lib/data/atoms";
import { useDeferredAutoAnimate } from "~/lib/hooks/useDeferredAutoAnimate";

interface ViewItemStandardListProps {
  items: string[];
  handleMouseSelect?: (itemId: string) => void;
  sectionItemType?: "feed" | "tag";
}

export function ViewItemStandardList({
  items,
  handleMouseSelect,
  sectionItemType,
}: ViewItemStandardListProps) {
  const selectedItemId = useAtomValue(selectedItemIdAtom);
  const [parent] = useDeferredAutoAnimate<HTMLDivElement>();

  return (
    <ViewListContainer>
      <div ref={parent} className="transition-all md:pt-2">
        {items.map((contentId) => {
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
            </Fragment>
          );
        })}
      </div>
    </ViewListContainer>
  );
}

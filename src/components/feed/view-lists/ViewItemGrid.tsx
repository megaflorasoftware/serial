"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { GridItemDisplay } from "./ItemDisplay";

interface ViewItemGridProps {
  items: string[];
}

export function ViewItemGrid({ items }: ViewItemGridProps) {
  const [parent] = useAutoAnimate();

  return (
    <div
      ref={parent}
      className="grid w-full grid-cols-2 gap-y-4 px-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(180px,_1fr))] md:gap-2"
    >
      {items.map((contentId) => (
        <GridItemDisplay
          contentId={contentId}
          key={contentId}
          size="standard"
        />
      ))}
    </div>
  );
}

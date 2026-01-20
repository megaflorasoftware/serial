"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { GridItemDisplay } from "./ItemDisplay";

interface ViewItemLargeGridProps {
  items: string[];
}

export function ViewItemLargeGrid({ items }: ViewItemLargeGridProps) {
  const [parent] = useAutoAnimate();

  return (
    <div
      ref={parent}
      className="grid w-full gap-4 px-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(250px,_1fr))]"
    >
      {items.map((contentId) => (
        <GridItemDisplay contentId={contentId} key={contentId} size="large" />
      ))}
    </div>
  );
}

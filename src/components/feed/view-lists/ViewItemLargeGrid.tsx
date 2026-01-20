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
      className="grid w-full px-4 pt-4 md:grid-cols-[repeat(auto-fill,_minmax(120px,_1fr))] md:grid-cols-[repeat(auto-fill,_minmax(250px,_1fr))] md:gap-2"
    >
      {items.map((contentId) => (
        <GridItemDisplay contentId={contentId} key={contentId} size="large" />
      ))}
    </div>
  );
}

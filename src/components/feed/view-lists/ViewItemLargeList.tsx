"use client";

import { useAutoAnimate } from "@formkit/auto-animate/react";
import { ItemDisplay } from "./ItemDisplay";

interface ViewItemLargeListProps {
  items: string[];
}

export function ViewItemLargeList({ items }: ViewItemLargeListProps) {
  const [parent] = useAutoAnimate();

  return (
    <div className="w-full transition-all md:pt-4 md:pr-6 md:pl-4" ref={parent}>
      {items.map((contentId) => (
        <ItemDisplay contentId={contentId} key={contentId} size="large" />
      ))}
    </div>
  );
}

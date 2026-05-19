"use client";

import { useEffect, useRef } from "react";
import {
  useAddVisibleItemId,
  useRemoveVisibleItemId,
} from "~/lib/data/visible-items-store";

interface VisibleItemTrackerProps {
  itemId: string;
  children: React.ReactNode;
}

export function VisibleItemTracker({
  itemId,
  children,
}: VisibleItemTrackerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const addVisibleItemId = useAddVisibleItemId();
  const removeVisibleItemId = useRemoveVisibleItemId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            addVisibleItemId(itemId);
          } else {
            removeVisibleItemId(itemId);
          }
        });
      },
      {
        root: null,
        rootMargin: "0px",
        threshold: 1, // Only fire when 100% visible
      },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      removeVisibleItemId(itemId);
    };
  }, [itemId, addVisibleItemId, removeVisibleItemId]);

  return <div ref={ref}>{children}</div>;
}

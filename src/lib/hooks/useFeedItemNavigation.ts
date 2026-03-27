"use client";

import { useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { useLocation, useRouter } from "@tanstack/react-router";
import { selectedItemIdAtom } from "~/lib/data/atoms";
import { useCanUseShortcuts } from "~/lib/hooks/useCanUseShortcuts";
import { orpcRouterClient } from "~/lib/orpc";
import { feedItemsStore } from "~/lib/data/store";
import { useFeeds as useFeedsArray } from "~/lib/data/feeds/store";

export function useFeedItemNavigation(items: string[]) {
  const [selectedItemId, setSelectedItemId] = useAtom(selectedItemIdAtom);
  const { pathname } = useLocation();
  const { canUseShortcuts } = useCanUseShortcuts();
  const router = useRouter();
  const feeds = useFeedsArray();

  const prevSelectedIdRef = useRef<string | null>(null);

  const selectNextItem = (currentIndex: number) => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < items.length) {
      setSelectedItemId(items[nextIndex]!);
    } else if (currentIndex > 0) {
      setSelectedItemId(items[currentIndex - 1]!);
    } else {
      setSelectedItemId(null);
    }
  };

  useEffect(() => {
    if (pathname !== "/") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!canUseShortcuts) return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          if (currentIndex === -1) {
            if (items.length > 0) {
              setSelectedItemId(items[0]!);
            }
          } else {
            const nextIndex = currentIndex + 1;
            if (nextIndex >= items.length) {
              setSelectedItemId(items[0]!);
            } else {
              setSelectedItemId(items[nextIndex]!);
            }
          }
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          if (currentIndex === -1) {
            if (items.length > 0) {
              setSelectedItemId(items[0]!);
            }
          } else if (currentIndex > 0) {
            setSelectedItemId(items[currentIndex - 1]!);
          }
          break;
        }
        case "e": {
          if (!selectedItemId) return;
          const item = feedItemsStore.getState().feedItemsDict[selectedItemId];
          if (!item) return;
          const idx = items.indexOf(selectedItemId);
          void orpcRouterClient.feedItem.setWatchedValue({
            id: selectedItemId,
            feedId: item.feedId,
            isWatched: !item.isWatched,
          });
          feedItemsStore.getState().setFeedItem(selectedItemId, {
            ...item,
            isWatched: !item.isWatched,
          });
          selectNextItem(idx);
          break;
        }
        case "w": {
          if (!selectedItemId) return;
          const item = feedItemsStore.getState().feedItemsDict[selectedItemId];
          if (!item) return;
          const idx = items.indexOf(selectedItemId);
          void orpcRouterClient.feedItem.setWatchLaterValue({
            id: selectedItemId,
            feedId: item.feedId,
            isWatchLater: !item.isWatchLater,
          });
          feedItemsStore.getState().setFeedItem(selectedItemId, {
            ...item,
            isWatchLater: !item.isWatchLater,
          });
          selectNextItem(idx);
          break;
        }
        case "Enter": {
          if (!selectedItemId) return;
          const item = feedItemsStore.getState().feedItemsDict[selectedItemId];
          if (!item) return;
          const feed = feeds.find((f: { id: number }) => f.id === item.feedId);

          const itemDestination =
            item.platform === "website" ? "read" : "watch";
          const shouldOpenInSerial =
            feed?.openLocation === "serial" || !feed?.openLocation;

          if (shouldOpenInSerial) {
            router.navigate({ to: `/${itemDestination}/${item.id}` });
          } else {
            window.open(item.url, "_blank", "noopener noreferrer");
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    pathname,
    canUseShortcuts,
    items,
    selectedItemId,
    setSelectedItemId,
    router,
    feeds,
  ]);

  useEffect(() => {
    if (selectedItemId && selectedItemId !== prevSelectedIdRef.current) {
      const element = document.querySelector(
        `[data-item-id="${selectedItemId}"]`,
      );
      if (element) {
        element.scrollIntoView({ block: "nearest" });
      }
    }
    prevSelectedIdRef.current = selectedItemId;
  }, [selectedItemId]);

  return { selectedItemId };
}

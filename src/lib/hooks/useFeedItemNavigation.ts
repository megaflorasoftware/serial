"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useLocation, useRouter } from "@tanstack/react-router";
import {
  categoryFilterAtom,
  feedFilterAtom,
  selectedItemIdAtom,
  softReadItemIdsAtom,
  viewFilterIdAtom,
} from "~/lib/data/atoms";
import { useCanUseShortcuts } from "~/lib/hooks/useCanUseShortcuts";
import { orpcRouterClient } from "~/lib/orpc";
import { feedItemsStore } from "~/lib/data/store";
import { useFeeds as useFeedsArray } from "~/lib/data/feeds/store";

// Module-level variable to track if we're returning from another route
// This persists across component unmounts
let isReturningFromOtherRoute = false;

function isElementInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0;
}

function getCentermostVisibleItem(items: string[]): string | null {
  const viewportCenter = window.innerHeight / 2;
  let closestItem: string | null = null;
  let closestDistance = Infinity;

  for (const itemId of items) {
    const element = document.querySelector(`[data-item-id="${itemId}"]`);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const elementCenter = rect.top + rect.height / 2;
    const distance = Math.abs(elementCenter - viewportCenter);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = itemId;
    }
  }

  return closestItem;
}

export function useFeedItemNavigation(items: string[]) {
  const [selectedItemId, setSelectedItemId] = useAtom(selectedItemIdAtom);
  const [, setSoftReadItemIds] = useAtom(softReadItemIdsAtom);
  const viewFilterId = useAtomValue(viewFilterIdAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const feedFilter = useAtomValue(feedFilterAtom);
  const { pathname } = useLocation();
  const { canUseShortcuts } = useCanUseShortcuts();
  const router = useRouter();
  const feeds = useFeedsArray();

  const prevSelectedIdRef = useRef<string | null>(null);
  const prevViewFilterIdRef = useRef<number | null>(null);
  const prevCategoryFilterRef = useRef<number | null>(null);
  const prevFeedFilterRef = useRef<number | null>(null);
  const shouldScrollRef = useRef(false);
  const keyboardNavActiveRef = useRef(false);

  const selectItemWithScroll = (itemId: string | null) => {
    shouldScrollRef.current = true;
    keyboardNavActiveRef.current = true;
    setSelectedItemId(itemId);
  };

  const selectNextItem = (currentIndex: number) => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < items.length) {
      selectItemWithScroll(items[nextIndex]!);
    } else if (currentIndex > 0) {
      selectItemWithScroll(items[currentIndex - 1]!);
    } else {
      selectItemWithScroll(null);
    }
  };

  const markAsRead = (itemId: string) => {
    const item = feedItemsStore.getState().feedItemsDict[itemId];
    if (!item) return;

    // Mark as read in database and local store
    void orpcRouterClient.feedItem.setWatchedValue({
      id: itemId,
      feedId: item.feedId,
      isWatched: true,
    });
    feedItemsStore.getState().setFeedItem(itemId, {
      ...item,
      isWatched: true,
    });

    // Add to soft read items so it still shows in unread filter
    setSoftReadItemIds((prev) => new Set([...prev, itemId]));
  };

  // Clear soft read items and reset selection when view/category/feed filter changes
  useEffect(() => {
    if (viewFilterId === null) return;

    const viewChanged =
      prevViewFilterIdRef.current !== null &&
      prevViewFilterIdRef.current !== viewFilterId;
    const categoryChanged =
      prevCategoryFilterRef.current !== null &&
      prevCategoryFilterRef.current !== categoryFilter;
    const feedChanged =
      prevFeedFilterRef.current !== null &&
      prevFeedFilterRef.current !== feedFilter;

    if (viewChanged || categoryChanged || feedChanged) {
      setSoftReadItemIds(new Set());
      setSelectedItemId(null);
      // Scroll to top instantly when changing views
      window.scrollTo({ top: 0, behavior: "instant" });
    }

    prevViewFilterIdRef.current = viewFilterId;
    prevCategoryFilterRef.current = categoryFilter;
    prevFeedFilterRef.current = feedFilter;
  }, [
    viewFilterId,
    categoryFilter,
    feedFilter,
    setSoftReadItemIds,
    setSelectedItemId,
  ]);

  // Handle returning from another route - scroll to selected item
  // Handle returning from another route - scroll to selected item
  useEffect(() => {
    if (pathname !== "/") {
      isReturningFromOtherRoute = true;
      return;
    }

    // Only scroll if we're returning from another route (not fresh mount)
    if (isReturningFromOtherRoute && selectedItemId) {
      isReturningFromOtherRoute = false;
      const element = document.querySelector(
        `[data-item-id="${selectedItemId}"]`,
      );
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "instant" });
      }
    }
  }, [pathname, selectedItemId]);

  useEffect(() => {
    if (pathname !== "/") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!canUseShortcuts) return;

      const isArrowKey = event.key === "ArrowDown" || event.key === "ArrowUp";
      if (event.repeat && !isArrowKey) return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();

          if (currentIndex === -1) {
            // If page hasn't been scrolled, select first item
            if (window.scrollY === 0 && items.length > 0) {
              selectItemWithScroll(items[0]!);
            } else {
              const centermostItem = getCentermostVisibleItem(items);
              if (centermostItem) {
                selectItemWithScroll(centermostItem);
              } else if (items.length > 0) {
                selectItemWithScroll(items[0]!);
              }
            }
          } else {
            const selectedElement = document.querySelector(
              `[data-item-id="${selectedItemId}"]`,
            );
            if (selectedElement && !isElementInViewport(selectedElement)) {
              const centermostItem = getCentermostVisibleItem(items);
              if (centermostItem) {
                selectItemWithScroll(centermostItem);
              }
            } else {
              const nextIndex = currentIndex + 1;
              if (nextIndex >= items.length) {
                selectItemWithScroll(items[0]!);
              } else {
                selectItemWithScroll(items[nextIndex]!);
              }
            }
          }
          break;
        }
        case "ArrowUp": {
          event.preventDefault();

          if (currentIndex === -1) {
            // If page hasn't been scrolled, select first item
            if (window.scrollY === 0 && items.length > 0) {
              selectItemWithScroll(items[0]!);
            } else {
              const centermostItem = getCentermostVisibleItem(items);
              if (centermostItem) {
                selectItemWithScroll(centermostItem);
              } else if (items.length > 0) {
                selectItemWithScroll(items[0]!);
              }
            }
          } else {
            const selectedElement = document.querySelector(
              `[data-item-id="${selectedItemId}"]`,
            );
            if (selectedElement && !isElementInViewport(selectedElement)) {
              const centermostItem = getCentermostVisibleItem(items);
              if (centermostItem) {
                selectItemWithScroll(centermostItem);
              }
            } else if (currentIndex > 0) {
              selectItemWithScroll(items[currentIndex - 1]!);
            }
          }
          break;
        }
        case "e": {
          if (!selectedItemId) return;
          const item = feedItemsStore.getState().feedItemsDict[selectedItemId];
          if (!item) return;
          const idx = items.indexOf(selectedItemId);
          const newIsWatched = !item.isWatched;
          void orpcRouterClient.feedItem.setWatchedValue({
            id: selectedItemId,
            feedId: item.feedId,
            isWatched: newIsWatched,
          });
          feedItemsStore.getState().setFeedItem(selectedItemId, {
            ...item,
            isWatched: newIsWatched,
          });
          // Add to soft read items and jump to next item only when marking as read
          if (newIsWatched) {
            setSoftReadItemIds((prev) => new Set([...prev, selectedItemId]));
            selectNextItem(idx);
          }
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

          // Mark as read when opening
          if (!item.isWatched) {
            markAsRead(selectedItemId);
          }

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
      if (shouldScrollRef.current) {
        const element = document.querySelector(
          `[data-item-id="${selectedItemId}"]`,
        );
        if (element) {
          element.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        shouldScrollRef.current = false;
      }
    }
    prevSelectedIdRef.current = selectedItemId;
  }, [selectedItemId]);

  useEffect(() => {
    const handleMouseMove = () => {
      keyboardNavActiveRef.current = false;
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  const handleMouseSelect = useCallback(
    (itemId: string) => {
      if (keyboardNavActiveRef.current) return;
      setSelectedItemId(itemId);
    },
    [setSelectedItemId],
  );

  return { selectedItemId, handleMouseSelect };
}

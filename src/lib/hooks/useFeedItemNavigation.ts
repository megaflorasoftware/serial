"use client";

import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useLocation } from "@tanstack/react-router";
import { useShortcut } from "./useShortcut";
import { useFeedItemActions } from "./useFeedItemActions";
import {
  categoryFilterAtom,
  feedFilterAtom,
  isReturningFromRouteAtom,
  selectedItemIdAtom,
  softReadItemIdsAtom,
  viewFilterIdAtom,
} from "~/lib/data/atoms";
import {
  getShortcutAllowRepeat,
  getShortcutKey,
  SHORTCUT_KEYS,
} from "~/lib/constants/shortcuts";

const SCROLL_DURATION_MS = 200;
const TARGET_VIEWPORT_POSITION = 1 / 3;

function isElementInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0;
}

function getClosestVisibleItem(items: string[]): string | null {
  const viewportTarget = window.innerHeight * TARGET_VIEWPORT_POSITION;
  let closestItem: string | null = null;
  let closestDistance = Infinity;

  for (const itemId of items) {
    const element = document.querySelector(`[data-item-id="${itemId}"]`);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const elementCenter = rect.top + rect.height / 2;
    const distance = Math.abs(elementCenter - viewportTarget);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = itemId;
    }
  }

  return closestItem;
}

export function useFeedItemNavigation(items: string[]) {
  const [selectedItemId, setSelectedItemId] = useAtom(selectedItemIdAtom);
  const setSoftReadItemIds = useSetAtom(softReadItemIdsAtom);
  const [isReturningFromRoute, setIsReturningFromRoute] = useAtom(
    isReturningFromRouteAtom,
  );
  const viewFilterId = useAtomValue(viewFilterIdAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const feedFilter = useAtomValue(feedFilterAtom);
  const { pathname } = useLocation();

  const prevViewFilterIdRef = useRef<number | null>(null);
  const prevCategoryFilterRef = useRef<number | null>(null);
  const prevFeedFilterRef = useRef<number | null>(null);
  const keyboardNavActiveRef = useRef(false);
  const lastNavTimeRef = useRef<number>(0);

  const selectedItemActions = useFeedItemActions(selectedItemId ?? "");

  const scrollToItem = useCallback(
    (itemId: string | null, forceInstant: boolean = false) => {
      if (!itemId) return;
      const element = document.querySelector(`[data-item-id="${itemId}"]`);
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const targetPosition = window.innerHeight * TARGET_VIEWPORT_POSITION;
      const scrollTop =
        window.scrollY + rect.top - targetPosition + rect.height / 2;

      const now = performance.now();
      const isRapid = now - lastNavTimeRef.current < SCROLL_DURATION_MS;
      lastNavTimeRef.current = now;

      if (forceInstant || isRapid) {
        window.scrollTo({ top: scrollTop, behavior: "instant" });
        return;
      }

      window.scrollTo({ top: scrollTop, behavior: "smooth" });
    },
    [],
  );

  const selectItem = useCallback(
    (itemId: string | null) => {
      keyboardNavActiveRef.current = true;
      setSelectedItemId(itemId);
      scrollToItem(itemId);
    },
    [setSelectedItemId, scrollToItem],
  );

  const selectNextItem = useCallback(
    (currentIndex: number) => {
      const nextIndex = currentIndex + 1;
      if (nextIndex < items.length) {
        selectItem(items[nextIndex]!);
      } else if (currentIndex > 0) {
        selectItem(items[currentIndex - 1]!);
      } else {
        selectItem(null);
      }
    },
    [items, selectItem],
  );

  const handleArrowDown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/") return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;

      if (currentIndex === -1) {
        if (window.scrollY === 0 && items.length > 0) {
          selectItem(items[0]!);
        } else {
          const closestItem = getClosestVisibleItem(items);
          if (closestItem) {
            selectItem(closestItem);
          } else if (items.length > 0) {
            selectItem(items[0]!);
          }
        }
      } else {
        const selectedElement = document.querySelector(
          `[data-item-id="${selectedItemId}"]`,
        );
        if (selectedElement && !isElementInViewport(selectedElement)) {
          const closestItem = getClosestVisibleItem(items);
          if (closestItem) {
            selectItem(closestItem);
          }
        } else {
          const nextIndex = currentIndex + 1;
          if (nextIndex >= items.length) {
            selectItem(items[0]!);
          } else {
            selectItem(items[nextIndex]!);
          }
        }
      }
    },
    [pathname, selectedItemId, items, selectItem],
  );

  const handleArrowUp = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/") return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;

      if (currentIndex === -1) {
        if (window.scrollY === 0 && items.length > 0) {
          selectItem(items[0]!);
        } else {
          const closestItem = getClosestVisibleItem(items);
          if (closestItem) {
            selectItem(closestItem);
          } else if (items.length > 0) {
            selectItem(items[0]!);
          }
        }
      } else {
        const selectedElement = document.querySelector(
          `[data-item-id="${selectedItemId}"]`,
        );
        if (selectedElement && !isElementInViewport(selectedElement)) {
          const closestItem = getClosestVisibleItem(items);
          if (closestItem) {
            selectItem(closestItem);
          }
        } else if (currentIndex > 0) {
          selectItem(items[currentIndex - 1]!);
        }
      }
    },
    [pathname, selectedItemId, items, selectItem],
  );

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_DOWN), handleArrowDown, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_DOWN),
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_UP), handleArrowUp, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_UP),
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.TOGGLE_READ), () => {
    if (pathname !== "/" || !selectedItemId) return;

    const wasMarkedRead = selectedItemActions.toggleRead();
    if (wasMarkedRead) {
      const idx = items.indexOf(selectedItemId);
      selectNextItem(idx);
    }
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.TOGGLE_LATER), () => {
    if (pathname !== "/" || !selectedItemId) return;

    selectedItemActions.toggleWatchLater();
    const idx = items.indexOf(selectedItemId);
    selectNextItem(idx);
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ENTER), () => {
    if (pathname !== "/" || !selectedItemId) return;
    selectedItemActions.openItem();
  });

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

  useEffect(() => {
    if (pathname !== "/") {
      setIsReturningFromRoute(true);
      return;
    }

    if (isReturningFromRoute && selectedItemId) {
      setIsReturningFromRoute(false);
      scrollToItem(selectedItemId, true);
    }
  }, [
    pathname,
    selectedItemId,
    isReturningFromRoute,
    setIsReturningFromRoute,
    scrollToItem,
  ]);

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

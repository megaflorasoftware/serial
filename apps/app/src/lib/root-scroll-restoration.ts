"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  getFeedItemElement,
  scrollRootItemToTarget,
} from "~/lib/hooks/useScrollToFeedItem";
import { getScrollContainer } from "~/lib/scroll";

type RootNavigationAnchor = {
  selectedItemId: string | null;
  successorItemId: string | null;
};

type CurrentRootNavigation = {
  itemIds: readonly string[];
  selectedItemId: string | null;
};

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

let currentRootNavigation: CurrentRootNavigation = {
  itemIds: [],
  selectedItemId: null,
};
let pendingRootNavigationAnchor: RootNavigationAnchor | null = null;
let savedRootRenderedItemCount: number | null = null;
let savedRootRenderedItemListKey: string | null = null;
let currentRootRenderedItemCount: number | null = null;
let currentRootRenderedItemListKey: string | null = null;

export function getNextRootItemId(
  itemIds: readonly string[],
  currentItemId: string | null,
) {
  if (!currentItemId) return null;

  const currentIndex = itemIds.indexOf(currentItemId);
  return currentIndex >= 0 ? (itemIds[currentIndex + 1] ?? null) : null;
}

export function resolveRootRestorationItemId({
  activeItemIds,
  selectedItemId,
  successorItemId,
}: {
  activeItemIds: readonly string[];
  selectedItemId: string | null;
  successorItemId: string | null;
}) {
  const activeItemIdSet = new Set(activeItemIds);
  if (selectedItemId && activeItemIdSet.has(selectedItemId)) {
    return selectedItemId;
  }
  if (successorItemId && activeItemIdSet.has(successorItemId)) {
    return successorItemId;
  }
  return null;
}

export function captureRootScrollRestoration(
  departingItemId: string | null = currentRootNavigation.selectedItemId,
) {
  const { itemIds } = currentRootNavigation;
  pendingRootNavigationAnchor = {
    selectedItemId: departingItemId,
    successorItemId: getNextRootItemId(itemIds, departingItemId),
  };

  if (
    currentRootRenderedItemListKey !== null &&
    currentRootRenderedItemCount !== null
  ) {
    savedRootRenderedItemListKey = currentRootRenderedItemListKey;
    savedRootRenderedItemCount = currentRootRenderedItemCount;
  }
}

export function updateCurrentRootRenderedItemCount(
  listKey: string,
  renderedItemCount: number,
) {
  currentRootRenderedItemListKey = listKey;
  currentRootRenderedItemCount = renderedItemCount;
}

export function getSavedRootRenderedItemCount(listKey: string) {
  if (savedRootRenderedItemListKey !== listKey) return null;

  return savedRootRenderedItemCount;
}

export function useRootScrollResetBeforePaint(enabled: boolean) {
  useIsomorphicLayoutEffect(() => {
    if (!enabled) return;
    getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
  }, [enabled]);
}

export type RootRestorationAction =
  | { type: "select"; itemId: string | null }
  | { type: "scroll"; itemId: string | null }
  | { type: "abort" }
  | { type: "recycle-anchor" }
  | { type: "clear-stale-selection" }
  | { type: "none" };

// Restoration may scroll only during the mount restoration (returning from
// the reader or a fresh load), and only while nothing else has moved the
// selection out from under it. Once the list is live, an item leaving it must
// never move the scroll position; at most the now-stale selection is cleared.
export function resolveRootRestorationAction({
  isInitialRestorationPass,
  activeItemIds,
  selectedItemId,
  anchor,
  restorationSelection,
}: {
  isInitialRestorationPass: boolean;
  activeItemIds: readonly string[];
  selectedItemId: string | null;
  anchor: RootNavigationAnchor;
  // The selection the restoration itself last applied; undefined until it has
  // applied one. A live selection that differs was set by something else
  // (hover, an action's advance), so restoration must stand down.
  restorationSelection?: string | null;
}): RootRestorationAction {
  if (isInitialRestorationPass) {
    if (
      restorationSelection !== undefined &&
      selectedItemId !== restorationSelection
    ) {
      return { type: "abort" };
    }
    const restorationItemId = resolveRootRestorationItemId({
      activeItemIds,
      ...anchor,
    });
    if (selectedItemId !== restorationItemId) {
      return { type: "select", itemId: restorationItemId };
    }
    return { type: "scroll", itemId: restorationItemId };
  }

  if (selectedItemId !== anchor.selectedItemId) {
    return { type: "recycle-anchor" };
  }
  if (selectedItemId && !activeItemIds.includes(selectedItemId)) {
    return { type: "clear-stale-selection" };
  }
  return { type: "none" };
}

export function useRootItemScrollRestoration({
  activeItemIds,
  selectedItemId,
  setSelectedItemId,
  ready,
}: {
  activeItemIds: readonly string[];
  selectedItemId: string | null;
  setSelectedItemId: (itemId: string | null) => void;
  ready: boolean;
}) {
  const needsRestorationRef = useRef(true);
  const restorationAnchorRef = useRef<RootNavigationAnchor | null>(null);
  const restorationSelectionRef = useRef<string | null | undefined>(undefined);

  useIsomorphicLayoutEffect(() => {
    currentRootNavigation = {
      itemIds: activeItemIds,
      selectedItemId,
    };
  }, [activeItemIds, selectedItemId]);

  // This layout effect must run before useFeedItemNavigation's deferred-scroll
  // passive effect so that restoration decides (or aborts) before an action's
  // advance scroll executes.
  useIsomorphicLayoutEffect(() => {
    if (!ready) return;

    if (restorationAnchorRef.current === null) {
      restorationAnchorRef.current = pendingRootNavigationAnchor ?? {
        selectedItemId,
        successorItemId: null,
      };
      // Consume the pending anchor as soon as it seeds this mount's anchor so
      // a capture that never led to a remount (for example a new-tab open)
      // cannot re-seed a stale anchor on every later pass.
      pendingRootNavigationAnchor = null;
    }
    const restorationAnchor = restorationAnchorRef.current;
    const action = resolveRootRestorationAction({
      isInitialRestorationPass: needsRestorationRef.current,
      activeItemIds,
      selectedItemId,
      anchor: restorationAnchor,
      restorationSelection: restorationSelectionRef.current,
    });

    switch (action.type) {
      case "select": {
        restorationSelectionRef.current = action.itemId;
        setSelectedItemId(action.itemId);
        return;
      }
      case "scroll": {
        if (action.itemId) {
          const itemElement = getFeedItemElement(action.itemId);
          if (!itemElement) return;
          scrollRootItemToTarget(itemElement, "instant");
        } else {
          getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
        }

        needsRestorationRef.current = false;
        if (action.itemId !== restorationAnchor.selectedItemId) {
          restorationAnchorRef.current = null;
        }
        return;
      }
      case "abort": {
        needsRestorationRef.current = false;
        restorationAnchorRef.current = null;
        return;
      }
      case "recycle-anchor": {
        restorationAnchorRef.current = null;
        return;
      }
      case "clear-stale-selection": {
        setSelectedItemId(null);
        restorationAnchorRef.current = null;
        return;
      }
      case "none": {
        return;
      }
    }
  }, [activeItemIds, ready, selectedItemId, setSelectedItemId]);
}

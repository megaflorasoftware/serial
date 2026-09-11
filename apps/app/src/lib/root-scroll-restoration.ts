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

type RootItemLinkClickEvent = {
  preventDefault: () => void;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
};

function opensInNewContext(event: RootItemLinkClickEvent) {
  return (
    Boolean(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) ||
    (event.button ?? 0) !== 0
  );
}

// A modifier or non-primary click opens elsewhere (TanStack Link runs the
// user's click handler before its own modifier check), so the list never
// unmounts and a capture would sit until some unrelated remount.
export function captureRootScrollRestorationOnClick(
  event: RootItemLinkClickEvent,
  departingItemId?: string,
) {
  if (opensInNewContext(event)) return;
  captureRootScrollRestoration(departingItemId);
}

export function createRootItemLinkClickHandler({
  canOpen,
  target,
  restorationId,
}: {
  canOpen: boolean;
  target: "_blank" | undefined;
  restorationId: string;
}) {
  return (event: RootItemLinkClickEvent) => {
    if (!canOpen) {
      event.preventDefault();
      return;
    }
    if (!target) captureRootScrollRestorationOnClick(event, restorationId);
  };
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
  | { type: "abort" };

// Restoration may scroll only during the mount restoration (returning from
// the reader or a fresh load), and only while nothing else has moved the
// selection out from under it. Once the mount restoration finishes, the hook
// does nothing at all: an item leaving the live list must never move the
// scroll position or the selection.
export function resolveRootRestorationAction({
  activeItemIds,
  selectedItemId,
  anchor,
  restorationSelection,
}: {
  activeItemIds: readonly string[];
  selectedItemId: string | null;
  anchor: RootNavigationAnchor;
  // The selection the restoration has observed or applied; undefined until
  // the first pass. A live selection that differs was set by something else
  // (hover, an action's advance), so restoration must stand down.
  restorationSelection?: string | null;
}): RootRestorationAction {
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
    // Restoration runs once per mount; afterwards this hook must never touch
    // the scroll position or the selection again.
    if (!needsRestorationRef.current) return;

    // Seed the abort guard with the first selection the mount restoration
    // observes, so a later selection change aborts it even when restoration
    // never applied a selection of its own (e.g. it is stuck retrying a
    // scroll target that has not rendered).
    if (restorationSelectionRef.current === undefined) {
      restorationSelectionRef.current = selectedItemId;
    }

    // The pending anchor is meant for one mount's restoration only. It is
    // read exclusively here (never on a live pass) and consumed the moment
    // this mount seeds from it, so a capture fired later in this mount's
    // lifetime stays intact for the next mount, and a stale one (an abort
    // that never scrolled) can't re-seed an unrelated later visit.
    if (restorationAnchorRef.current === null) {
      restorationAnchorRef.current = pendingRootNavigationAnchor ?? {
        selectedItemId,
        successorItemId: null,
      };
      pendingRootNavigationAnchor = null;
    }
    const action = resolveRootRestorationAction({
      activeItemIds,
      selectedItemId,
      anchor: restorationAnchorRef.current,
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
        return;
      }
      case "abort": {
        // The anchor this mount seeded from is already consumed; a capture
        // fired since (the click that caused this abort) belongs to the next
        // mount and must stay pending.
        needsRestorationRef.current = false;
        return;
      }
    }
  }, [activeItemIds, ready, selectedItemId, setSelectedItemId]);
}

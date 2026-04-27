"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import {
  categoryFilterAtom,
  feedFilterAtom,
  UNSELECTED_VIEW_ID,
  viewFilterIdAtom,
  viewsAtom,
} from "./atoms";
import { useStoresHydrated } from "./hydration";
import { feedItemsStore } from "./store";
import { useDataSubscription } from "./useDataSubscription";
import { useUpdateViewFilter } from "./views";
import { useViewsFetchStatus, useViews as useViewsStore } from "./views/store";
import type { PropsWithChildren } from "react";

export function InitialClientQueries({ children }: PropsWithChildren) {
  const { requestInitialData } = useDataSubscription();
  const hasRequestedInitialData = useRef(false);
  const hydrated = useStoresHydrated();

  // Sync views store with viewsAtom for compatibility
  const viewsFromStore = useViewsStore();
  const viewsFetchStatus = useViewsFetchStatus();
  const setViewsAtom = useSetAtom(viewsAtom);
  const updateViewFilter = useUpdateViewFilter();

  // Read filter atoms for auto-selection logic
  const viewFilterId = useAtomValue(viewFilterIdAtom);
  const feedFilter = useAtomValue(feedFilterAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);

  // Request initial data once stores have hydrated from IDB.
  // Gating on hydration ensures cached data is loaded first, preventing
  // fresh SSE data from being overwritten by a late hydration merge.
  // Build per-view manifests so the server can diff against the client's
  // cached items and only send what changed.
  useEffect(() => {
    if (!hasRequestedInitialData.current && hydrated) {
      hasRequestedInitialData.current = true;

      const { feedItemsDict, viewFeedIds } = feedItemsStore.getState();
      const hasCachedData = Object.keys(feedItemsDict).length > 0;

      if (hasCachedData) {
        // Build viewManifests: for each cached view, group items by visibility filter.
        // This is critical — the server diffs per visibility filter, so if we sent
        // a flat manifest the server would mark read/later items as "deleted"
        // during the unread diff (and vice versa).
        const viewManifests: Record<
          number,
          Record<string, Array<{ id: string; contentHash: string | null }>>
        > = {};

        for (const [viewIdStr, feedIds] of Object.entries(viewFeedIds)) {
          const viewId = Number(viewIdStr);
          const feedIdSet = new Set(feedIds);
          const unread: Array<{ id: string; contentHash: string | null }> = [];
          const read: Array<{ id: string; contentHash: string | null }> = [];
          const later: Array<{ id: string; contentHash: string | null }> = [];

          for (const [id, item] of Object.entries(feedItemsDict)) {
            if (!feedIdSet.has(item.feedId)) continue;
            const entry = { id, contentHash: item.contentHash ?? null };

            if (item.isWatchLater) {
              later.push(entry);
            } else if (item.isWatched) {
              read.push(entry);
            } else {
              unread.push(entry);
            }
          }

          viewManifests[viewId] = { unread, read, later };
        }

        void requestInitialData({ viewManifests });
      } else {
        void requestInitialData();
      }
    }
  }, [requestInitialData, hydrated]);

  // Keep viewsAtom always in sync with store
  useEffect(() => {
    if (viewsFetchStatus === "success" && viewsFromStore.length > 0) {
      setViewsAtom(viewsFromStore);
    }
  }, [viewsFetchStatus, viewsFromStore, setViewsAtom]);

  // Auto-select first view when nothing is selected
  useEffect(() => {
    const nothingSelected =
      viewFilterId === UNSELECTED_VIEW_ID &&
      feedFilter === -1 &&
      categoryFilter === -1;

    if (nothingSelected && viewsFromStore.length > 0) {
      const firstView = viewsFromStore[0];
      if (firstView) {
        updateViewFilter(firstView.id, viewsFromStore);
      }
    }
  }, [
    viewFilterId,
    feedFilter,
    categoryFilter,
    viewsFromStore,
    updateViewFilter,
  ]);

  return children;
}

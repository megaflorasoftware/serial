"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { visibilityFilterAtom } from "~/lib/data/atoms";
import { feedItemsStore } from "~/lib/data/store";
import { viewsStore } from "~/lib/data/views/store";
import { dataSubscriptionActions } from "~/lib/data/useDataSubscription";

/**
 * Hook that triggers lazy loading of items when visibility filter changes.
 * Fetches items for ALL views when switching to "read" or "later" filters.
 *
 * Should be called in a component that renders the feed items list.
 */
export function useLazyVisibilityFilter() {
  const visibilityFilter = useAtomValue(visibilityFilterAtom);

  useEffect(() => {
    // "unread" is already fetched for all views on initial load
    if (visibilityFilter === "unread") return;

    // Check which views need fetching for this visibility filter
    const allViews = viewsStore.getState().views;
    const fetchedFilters = feedItemsStore.getState().fetchedVisibilityFilters;

    // Request items for each view that hasn't been fetched yet
    for (const view of allViews) {
      const viewFetchedFilters = fetchedFilters[view.id];
      if (!viewFetchedFilters?.has(visibilityFilter)) {
        // Request items via the publisher pattern
        void dataSubscriptionActions.requestItemsByVisibility(
          view.id,
          visibilityFilter,
        );
      }
    }
  }, [visibilityFilter]);
}

"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { viewFilterAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import {
  useFetchedVisibilityFilters,
  useFetchItemsForVisibility,
} from "~/lib/data/store";

/**
 * Hook that triggers lazy loading of items when visibility filter changes.
 * Only fetches if the current visibility filter hasn't been fetched for the current view.
 *
 * Should be called in a component that renders the feed items list.
 */
export function useLazyVisibilityFilter() {
  const currentView = useAtomValue(viewFilterAtom);
  const visibilityFilter = useAtomValue(visibilityFilterAtom);
  const fetchItemsForVisibility = useFetchItemsForVisibility();
  const fetchedVisibilityFilters = useFetchedVisibilityFilters();

  useEffect(() => {
    if (!currentView) return;

    const viewId = currentView.id;
    const fetchedFilters = fetchedVisibilityFilters[viewId];

    // Only fetch if we haven't fetched this visibility filter for this view
    if (!fetchedFilters?.has(visibilityFilter)) {
      fetchItemsForVisibility(viewId, visibilityFilter);
    }
  }, [
    currentView,
    visibilityFilter,
    fetchItemsForVisibility,
    fetchedVisibilityFilters,
  ]);
}

"use client";

import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { viewsAtom } from "./atoms";
import { useUpdateViewFilter } from "./views";
import { useCurrentViewId, useFetchByView, useFetchFeedItemsStatus } from "./store";
import { useFetchStatus as useViewsFetchStatus, useViews as useViewsStore } from "./views/store";
import type { PropsWithChildren } from "react";

export function InitialClientQueries({ children }: PropsWithChildren) {
  const fetchByView = useFetchByView();
  const currentViewId = useCurrentViewId();
  const fetchStatus = useFetchFeedItemsStatus();
  const hasInitialized = useRef(false);

  // Sync views store with viewsAtom for compatibility
  const viewsFromStore = useViewsStore();
  const viewsFetchStatus = useViewsFetchStatus();
  const setViewsAtom = useSetAtom(viewsAtom);
  const updateViewFilter = useUpdateViewFilter();

  useEffect(() => {
    void fetchByView();
  }, []);

  // Sync viewsAtom and set initial view filter when ready
  useEffect(() => {
    if (
      !hasInitialized.current &&
      fetchStatus === "success" &&
      viewsFetchStatus === "success" &&
      viewsFromStore.length > 0 &&
      currentViewId !== null
    ) {
      hasInitialized.current = true;
      // Sync views to atom
      setViewsAtom(viewsFromStore);
      // Set initial view filter, passing views directly to avoid timing issues
      updateViewFilter(currentViewId, viewsFromStore);
    }
  }, [fetchStatus, viewsFetchStatus, viewsFromStore, currentViewId, setViewsAtom, updateViewFilter]);

  // Keep viewsAtom in sync when views change after initialization
  useEffect(() => {
    if (hasInitialized.current && viewsFromStore.length > 0) {
      setViewsAtom(viewsFromStore);
    }
  }, [viewsFromStore, setViewsAtom]);

  return children;
}

"use client";

import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { viewsAtom } from "./atoms";
import { useUpdateViewFilter } from "./views";
import { useCurrentViewId, useFetchByView, useFetchFeedItemsStatus } from "./store";
import { useViewsFetchStatus, useViews as useViewsStore } from "./views/store";
import type { PropsWithChildren } from "react";

export function InitialClientQueries({ children }: PropsWithChildren) {
  const fetchByView = useFetchByView();
  const currentViewId = useCurrentViewId();
  const fetchStatus = useFetchFeedItemsStatus();
  const hasSetInitialView = useRef(false);

  // Sync views store with viewsAtom for compatibility
  const viewsFromStore = useViewsStore();
  const viewsFetchStatus = useViewsFetchStatus();
  const setViewsAtom = useSetAtom(viewsAtom);
  const updateViewFilter = useUpdateViewFilter();

  useEffect(() => {
    void fetchByView();
  }, []);

  // Keep viewsAtom always in sync with store
  useEffect(() => {
    if (viewsFetchStatus === "success" && viewsFromStore.length > 0) {
      setViewsAtom(viewsFromStore);
    }
  }, [viewsFetchStatus, viewsFromStore, setViewsAtom]);

  // Set initial view filter once when ready
  useEffect(() => {
    if (
      !hasSetInitialView.current &&
      fetchStatus === "success" &&
      viewsFetchStatus === "success" &&
      viewsFromStore.length > 0 &&
      currentViewId !== null
    ) {
      hasSetInitialView.current = true;
      updateViewFilter(currentViewId, viewsFromStore);
    }
  }, [fetchStatus, viewsFetchStatus, viewsFromStore, currentViewId, updateViewFilter]);

  return children;
}

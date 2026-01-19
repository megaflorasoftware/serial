"use client";

import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { viewsAtom } from "./atoms";
import { useUpdateViewFilter } from "./views";
import { useFetchByView, useCurrentViewId, useFetchFeedItemsStatus } from "./store";
import { useViews as useViewsStore, useViewsFetchStatus } from "./views/store";
import type { PropsWithChildren } from "react";

export function InitialClientQueries({ children }: PropsWithChildren) {
  const fetchByView = useFetchByView();
  const currentViewId = useCurrentViewId();
  const fetchStatus = useFetchFeedItemsStatus();

  // Sync views store with viewsAtom for compatibility
  const viewsFromStore = useViewsStore();
  const viewsFetchStatus = useViewsFetchStatus();
  const setViewsAtom = useSetAtom(viewsAtom);

  useEffect(() => {
    void fetchByView();
  }, []);

  // Keep viewsAtom in sync with views from the store (including Inbox)
  useEffect(() => {
    if (viewsFetchStatus === "success" && viewsFromStore.length > 0) {
      setViewsAtom(viewsFromStore);
    }
  }, [viewsFetchStatus, viewsFromStore, setViewsAtom]);

  // Set the initial view filter once we have views and feed items
  const updateViewFilter = useUpdateViewFilter();

  useEffect(() => {
    if (
      fetchStatus === "success" &&
      viewsFetchStatus === "success" &&
      currentViewId !== null
    ) {
      updateViewFilter(currentViewId);
    }
  }, [fetchStatus, viewsFetchStatus, currentViewId, updateViewFilter]);

  return children;
}

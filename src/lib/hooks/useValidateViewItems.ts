"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import type { ClientManifestEntry } from "~/server/api/routers/initialRouter";
import {
  categoryFilterAtom,
  feedFilterAtom,
  viewFilterAtom,
  visibilityFilterAtom,
} from "~/lib/data/atoms";
import { feedItemsStore } from "~/lib/data/store";
import { dataSubscriptionActions } from "~/lib/data/useDataSubscription";

const validatingCombos = new Set<string>();

/**
 * Background-validates the cached items for the current view + visibility
 * filter by sending a manifest of cached item IDs + contentHash to the
 * server. The server diffs the manifest against its ground truth and streams
 * back a `view-diff` chunk (handled by the store's `processChunk`).
 *
 * Cached content is shown immediately; updates/deletions/new items stream
 * in transparently without any loading UI.
 */
export function useValidateViewItems() {
  const viewFilter = useAtomValue(viewFilterAtom);
  const visibilityFilter = useAtomValue(visibilityFilterAtom);
  const feedFilter = useAtomValue(feedFilterAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);

  useEffect(() => {
    // Feed / category selections use separate endpoints — skip here
    if (feedFilter >= 0 || categoryFilter >= 0) return;

    const viewId = viewFilter?.id;
    if (viewId === undefined || viewId === null) return;

    const key = `${viewId}-${visibilityFilter}`;
    if (validatingCombos.has(key)) return;
    validatingCombos.add(key);

    const state = feedItemsStore.getState();

    // Only include items that belong to the current view's feeds so the
    // server diff doesn't return spurious deletions for items from other views.
    const viewFeedIds = state.viewFeedIds[viewId];
    if (!viewFeedIds || viewFeedIds.length === 0) {
      validatingCombos.delete(key);
      return;
    }
    const viewFeedIdSet = new Set(viewFeedIds);

    const manifest: ClientManifestEntry[] = [];
    for (const id of state.feedItemsOrder) {
      const item = state.feedItemsDict[id];
      if (!item) continue;
      if (!viewFeedIdSet.has(item.feedId)) continue;

      manifest.push({ id, contentHash: item.contentHash });
    }

    void dataSubscriptionActions
      .requestItemsByVisibility(
        viewId,
        visibilityFilter,
        undefined,
        undefined,
        manifest.length > 0 ? manifest : undefined,
      )
      .finally(() => {
        validatingCombos.delete(key);
      });
  }, [viewFilter, visibilityFilter, feedFilter, categoryFilter]);
}

"use client";

import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useStore } from "zustand";
import type { ReaderChunkPreloadStatus } from "~/lib/pwa/reader-chunk-preload";
import { connectionStateAtom } from "~/lib/data/atoms";
import { bookmarkCapturesStore } from "~/lib/data/bookmarks/capture-store";
import { feedItemsStore } from "~/lib/data/store";
import {
  hasAnyKey,
  shouldPreloadReaderChunk,
} from "~/lib/pwa/reader-chunk-preload";

// Session-scoped: the router caches a loaded chunk, and a failed load cannot
// be retried without a reload, so one attempt per page lifetime is all that
// is useful.
let status: ReaderChunkPreloadStatus = "idle";

function useHasOfflineContent() {
  const hasRetainedFeedBody = useStore(feedItemsStore, (state) =>
    hasAnyKey(state.retainedFeedItemBodyIds),
  );
  const hasBookmarkCapture = useStore(bookmarkCapturesStore, (state) =>
    hasAnyKey(state.capturesDict),
  );
  return hasRetainedFeedBody || hasBookmarkCapture;
}

export function ReaderChunkPreloader() {
  const router = useRouter();
  const connectionState = useAtomValue(connectionStateAtom);
  const hasOfflineContent = useHasOfflineContent();

  useEffect(() => {
    if (
      !shouldPreloadReaderChunk({ connectionState, hasOfflineContent, status })
    ) {
      return;
    }
    status = "loading";
    const readerRoute = router.routesById["/_app/read/$id"];
    Promise.resolve(router.loadRouteChunk(readerRoute)).then(
      () => {
        status = "loaded";
      },
      () => {
        // The router already recorded the failure on the route; a later
        // navigation reloads the page once, which resets everything.
        status = "loaded";
      },
    );
  }, [connectionState, hasOfflineContent, router]);

  return null;
}

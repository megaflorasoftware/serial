"use client";

import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useStore } from "zustand";
import { connectionStateAtom } from "~/lib/data/atoms";
import { bookmarkCapturesStore } from "~/lib/data/bookmarks/capture-store";
import { feedItemsStore } from "~/lib/data/store";
import {
  getReaderChunkPreloadStatus,
  hasAnyKey,
  setReaderChunkPreloadStatus,
  shouldPreloadReaderChunk,
} from "~/lib/pwa/reader-chunk-preload";

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
      !shouldPreloadReaderChunk({
        connectionState,
        hasOfflineContent,
        status: getReaderChunkPreloadStatus(),
      })
    ) {
      return;
    }
    setReaderChunkPreloadStatus("loading");
    const readerRoute = router.routesById["/_app/read/$id"];
    Promise.resolve(router.loadRouteChunk(readerRoute)).then(
      () => {
        setReaderChunkPreloadStatus("loaded");
      },
      () => {
        // The router keeps the failed import on the route and skips further
        // chunk loads for it, so a retry cannot fetch again; a later
        // navigation reloads the page once, which resets everything.
        setReaderChunkPreloadStatus("loaded");
      },
    );
  }, [connectionState, hasOfflineContent, router]);

  return null;
}

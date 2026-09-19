"use client";

import { useEffect, useState } from "react";
import { mergeFeedItem } from "~/lib/data/feed-items/mergeFeedItem";
import { refreshFeedItemReferences } from "~/lib/data/feed-items/referenceRefresh";
import { feedItemsStore, retainLoadedFeedItemBody } from "~/lib/data/store";
import { orpcRouterClient } from "~/lib/orpc";

export function useRefreshFeedItem(id: string | undefined) {
  const [refreshState, setRefreshState] = useState<{
    id: string;
    complete: boolean;
    succeeded: boolean;
  }>();

  // A canceled intermediate visit must not revive an earlier visit's result.
  if (refreshState && refreshState.id !== id) setRefreshState(undefined);

  useEffect(() => {
    if (!id) return;

    let canceled = false;
    let succeeded = false;
    const initialItem = feedItemsStore.getState().feedItemsDict[id];

    const refresh = async (retry: boolean): Promise<void> => {
      if (canceled) return;
      const requestedItem = feedItemsStore.getState().feedItemsDict[id];
      const item = await orpcRouterClient.feedItem.getById({ id });
      if (canceled || !item) return;

      const currentItem = feedItemsStore.getState().feedItemsDict[id];
      if (requestedItem && !currentItem) return;
      const currentUpdatedAt = currentItem?.updatedAt?.getTime() ?? 0;
      const incomingUpdatedAt = item.updatedAt?.getTime() ?? 0;

      const hasConcurrentRevision =
        currentUpdatedAt === incomingUpdatedAt &&
        currentItem?.contentHash !== requestedItem?.contentHash &&
        currentItem?.contentHash !== item.contentHash;
      const hasNewerMetadata = currentUpdatedAt > incomingUpdatedAt;
      if (
        hasConcurrentRevision ||
        (hasNewerMetadata &&
          (!currentItem?.contentHash ||
            currentItem.contentHash !== item.contentHash))
      ) {
        if (retry) await refresh(false);
        return;
      }
      // The body still belongs to the same revision; preserve newer user choices.
      const incoming =
        hasNewerMetadata && currentItem
          ? {
              ...currentItem,
              body: item.body,
              contentSnippet: item.contentSnippet,
            }
          : item;
      const concurrentUserState =
        currentItem && currentItem !== initialItem
          ? {
              ...(currentItem.isWatched !== initialItem?.isWatched
                ? {
                    isWatched: currentItem.isWatched,
                    isWatchedUpdatedAt: currentItem.isWatchedUpdatedAt,
                  }
                : {}),
              ...(currentItem.isWatchLater !== initialItem?.isWatchLater
                ? {
                    isWatchLater: currentItem.isWatchLater,
                    isWatchLaterUpdatedAt: currentItem.isWatchLaterUpdatedAt,
                  }
                : {}),
              ...(currentItem.progress !== initialItem?.progress ||
              currentItem.duration !== initialItem?.duration
                ? {
                    progress: currentItem.progress,
                    duration: currentItem.duration,
                  }
                : {}),
            }
          : {};

      feedItemsStore
        .getState()
        .setFeedItem(
          id,
          mergeFeedItem(currentItem, { ...incoming, ...concurrentUserState }),
        );
      retainLoadedFeedItemBody(id);
      succeeded = true;
      // Nonblocking: the render never waits on fresher Reference snapshots,
      // and a refresh keeps the revision, so progress and offline rules hold.
      void refreshFeedItemReferences(id);
    };

    void refresh(true)
      .catch((error) => {
        console.error("Error refreshing feed item:", error);
      })
      .finally(() => {
        if (!canceled) setRefreshState({ id, complete: true, succeeded });
      });

    return () => {
      canceled = true;
    };
  }, [id]);

  return {
    complete: refreshState?.id === id && !!refreshState?.complete,
    succeeded: refreshState?.id === id && !!refreshState?.succeeded,
  };
}

"use client";

import { useEffect, useState } from "react";
import { mergeFeedItem } from "~/lib/data/feed-items/mergeFeedItem";
import { feedItemsStore, retainLoadedFeedItemBody } from "~/lib/data/store";
import { orpcRouterClient } from "~/lib/orpc";

export function useRefreshFeedItem(id: string | undefined) {
  const [refreshState, setRefreshState] = useState<{
    id: string;
    complete: boolean;
    succeeded: boolean;
  }>();

  useEffect(() => {
    if (!id) return;

    let canceled = false;
    let succeeded = false;

    void orpcRouterClient.feedItem
      .getById({ id })
      .then((item) => {
        if (canceled || !item) return;

        const currentItem = feedItemsStore.getState().feedItemsDict[id];
        const currentUpdatedAt = currentItem?.updatedAt?.getTime() ?? 0;
        const incomingUpdatedAt = item.updatedAt?.getTime() ?? 0;

        if (currentUpdatedAt > incomingUpdatedAt) return;

        feedItemsStore
          .getState()
          .setFeedItem(id, mergeFeedItem(currentItem, item));
        retainLoadedFeedItemBody(id);
        succeeded = true;
      })
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

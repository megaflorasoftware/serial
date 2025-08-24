import { useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";

export function useFeedItemsCollection() {
  return useTanstackDBContext().feedItemsCollection;
}

export function useFeedItemsLiveQuery() {
  const feedItemsCollection = useFeedItemsCollection();
  return useLiveQuery((q) => q.from({ feedItem: feedItemsCollection }));
}

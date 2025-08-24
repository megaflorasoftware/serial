import { useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";
import { useAllFiltersLiveQuery } from "./filters";
import { useAllFeedsLiveQuery } from "./feeds";
import { useViewsLiveQuery } from "./views";

export function useFeedItemsCollection() {
  return useTanstackDBContext().feedItemsCollection;
}

export function useFeedItemsLiveQuery() {
  const feedItemsCollection = useFeedItemsCollection();
  return useLiveQuery((q) => q.from({ feedItem: feedItemsCollection }));
}

export function useFilteredFeedItemsLiveQuery() {
  const { data: feeds } = useAllFeedsLiveQuery();
  const { data: views } = useViewsLiveQuery();
  const { data: filters } = useAllFiltersLiveQuery();
}

import { eq, useLiveQuery } from "@tanstack/react-db";
import { useTanstackDBContext } from "./TanstackDBProvider";

export function useFeedsCollection() {
  return useTanstackDBContext().feedsCollection;
}

export function useAllFeedsLiveQuery() {
  const feedsCollection = useFeedsCollection();

  return useLiveQuery((q) => q.from({ feed: feedsCollection }));
}

export function useSingleFeedLiveQuery(id: number | null) {
  const feedsCollection = useFeedsCollection();
  const query = useLiveQuery(
    (q) =>
      q.from({ feed: feedsCollection }).where(({ feed }) => eq(feed.id, id)),
    [id],
  );

  return {
    ...query,
    data: query.data?.[0],
  };
}

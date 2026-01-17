import { useMutation } from "@tanstack/react-query";
import { orpc } from "~/lib/orpc";
import {
  feedItemsStore,
  useFeedItemsDict,
  useFeedItemsOrder,
  useFetchFeedItems,
} from "../store";
import { useFetchFeedCategories } from "../feed-categories/store";
import {
  useFeeds as useFeedsFromStore,
  useSetFeeds,
  useFetchFeeds,
  feedsStore,
} from "./store";

export function useCreateFeedMutation() {
  const refetchFeedItems = useFetchFeedItems();
  const fetchFeedCategories = useFetchFeedCategories();
  const setFeeds = useSetFeeds();
  const fetchFeeds = useFetchFeeds();

  return useMutation(
    orpc.feed.create.mutationOptions({
      onSuccess: async () => {
        // Reset and refetch feeds
        setFeeds([]);
        await fetchFeeds();
        refetchFeedItems();
        await fetchFeedCategories();
      },
    }),
  );
}

export function useCreateFeedsFromSubscriptionImportMutation() {
  const refetchFeedItems = useFetchFeedItems();
  const fetchFeedCategories = useFetchFeedCategories();
  const setFeeds = useSetFeeds();
  const fetchFeeds = useFetchFeeds();

  return useMutation(
    orpc.feed.createFromSubscriptionImport.mutationOptions({
      onSuccess: async () => {
        // Reset and refetch feeds
        setFeeds([]);
        await fetchFeeds();
        refetchFeedItems();
        await fetchFeedCategories();
      },
    }),
  );
}

export function useDeleteFeedMutation() {
  const feeds = useFeedsFromStore();
  const setFeeds = useSetFeeds();
  const fetchFeeds = useFetchFeeds();

  const feedItemsOrder = useFeedItemsOrder();
  const feedItemsDict = useFeedItemsDict();

  const setFeedItemsOrder = feedItemsStore.useSetFeedItemsOrder();
  const setFeedItemsDict = feedItemsStore.useSetFeedItemsDict();

  const refetchFeedItems = useFetchFeedItems();

  return useMutation(
    orpc.feed.delete.mutationOptions({
      onSuccess: async (_, feedId) => {
        setFeeds(feeds.filter((feed) => feed.id !== feedId));

        const [updatedFeedItemsOrder, removedFeedItems] = feedItemsOrder.reduce(
          ([partialKeptItems, partialRemovedItems], feedItemContentId) => {
            if (feedItemsDict[feedItemContentId]?.feedId === feedId) {
              partialRemovedItems.push(feedItemContentId);
            } else {
              partialKeptItems.push(feedItemContentId);
            }

            return [partialKeptItems, partialRemovedItems];
          },
          [[], []] as [string[], string[]],
        );

        const updatedfeedItemsDict = removedFeedItems.reduce(
          (partialMap, feedItemContentId) => {
            delete partialMap[feedItemContentId];
            return partialMap;
          },
          { ...feedItemsDict },
        );

        setFeedItemsOrder(updatedFeedItemsOrder);
        setFeedItemsDict(updatedfeedItemsDict);

        // Reset and refetch feeds
        setFeeds([]);
        await fetchFeeds();
        refetchFeedItems();
      },
    }),
  );
}

export function useEditFeedMutation() {
  const fetchFeedCategories = useFetchFeedCategories();
  const setFeeds = useSetFeeds();
  const fetchFeeds = useFetchFeeds();

  return useMutation(
    orpc.feed.update.mutationOptions({
      onSuccess: async () => {
        // Reset and refetch feeds
        setFeeds([]);
        await fetchFeeds();
        await fetchFeedCategories();
      },
    }),
  );
}

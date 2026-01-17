import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFeeds } from ".";
import { orpc } from "~/lib/orpc";
import {
  feedItemsStore,
  useFeedItemsDict,
  useFeedItemsOrder,
  useFetchFeedItems,
} from "../store";
import { useFetchFeedCategories } from "../feed-categories/store";

export function useCreateFeedMutation() {
  const queryClient = useQueryClient();
  const refetchFeedItems = useFetchFeedItems();
  const fetchFeedCategories = useFetchFeedCategories();

  return useMutation(
    orpc.feed.create.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.feed.getAll.queryKey(),
        });
        refetchFeedItems();
        await fetchFeedCategories();
      },
    }),
  );
}

export function useCreateFeedsFromSubscriptionImportMutation() {
  const queryClient = useQueryClient();
  const refetchFeedItems = useFetchFeedItems();
  const fetchFeedCategories = useFetchFeedCategories();

  return useMutation(
    orpc.feed.createFromSubscriptionImport.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.feed.getAll.queryKey(),
        });
        refetchFeedItems();
        await fetchFeedCategories();
      },
    }),
  );
}

export function useDeleteFeedMutation() {
  const queryClient = useQueryClient();

  const { feeds, setFeeds } = useFeeds();

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

        await queryClient.invalidateQueries({
          queryKey: orpc.feed.getAll.queryKey(),
        });
        refetchFeedItems();
      },
    }),
  );
}

export function useEditFeedMutation() {
  const queryClient = useQueryClient();
  const fetchFeedCategories = useFetchFeedCategories();

  return useMutation(
    orpc.feed.update.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.feed.getAll.queryKey(),
        });
        await fetchFeedCategories();
      },
    }),
  );
}

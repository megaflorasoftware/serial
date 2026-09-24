import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { useFetchFeedCategories } from "../feed-categories/store";
import { useFetchViewFeeds } from "../view-feeds/store";
import { useFetchViews, useRemoveFeedReferences } from "../views/store";
import { feedItemsStore, useFetchFeedItemsForFeed } from "../store";
import {
  feedsStore,
  useAddFeed,
  useFetchFeeds,
  useRemoveFeed,
  useUpdateFeed,
} from "./store";
import type {
  ApplicationFeed,
  ApplicationFeedOrigin,
} from "~/server/db/schema";
import { useDialogStore } from "~/components/feed/dialogStore";
import { orpc } from "~/lib/orpc";
import { refreshNavigationSnapshotSafely } from "~/lib/data/navigation/store";

const REVALIDATE_FEED_MUTATION_KEY = ["feed", "revalidate"] as const;
const revalidatingFeedIds = new Set<number>();

function mergeRevalidatedOrigins(
  current: ApplicationFeedOrigin[],
  returned: ApplicationFeedOrigin[],
) {
  const returnedKinds = new Set(returned.map((origin) => origin.kind));
  return [
    ...returned,
    ...current.filter((origin) => !returnedKinds.has(origin.kind)),
  ];
}

export function useIsFeedRevalidating(feedId: number | null) {
  return (
    useIsMutating({
      mutationKey: REVALIDATE_FEED_MUTATION_KEY,
      predicate: (mutation) =>
        (mutation.state.variables as { feedId?: number } | undefined)
          ?.feedId === feedId,
    }) > 0
  );
}

/**
 * Creating a Feed only needs its row. The first item import runs behind a
 * toast so the dialog can move on; the Feed keeps its sidebar status either way.
 */
export function importFeedItemsWithToast(
  feed: Pick<ApplicationFeed, "id" | "name">,
  fetchItems: (feedId: number) => Promise<void>,
) {
  const importing = fetchItems(feed.id);
  toast.promise(importing, {
    id: `feed-import:${feed.id}`,
    loading: `Importing items from ${feed.name}…`,
    error: (error) =>
      error instanceof Error
        ? error.message
        : `Something went wrong importing items from ${feed.name}.`,
  });
  return importing;
}

export function useImportFeedItems() {
  const fetchFeedItemsForFeed = useFetchFeedItemsForFeed();
  return (feed: Pick<ApplicationFeed, "id" | "name">) =>
    importFeedItemsWithToast(feed, fetchFeedItemsForFeed);
}

export function useCreateFeedMutation() {
  const fetchFeedCategories = useFetchFeedCategories();
  const fetchViewFeeds = useFetchViewFeeds();
  const fetchViews = useFetchViews();
  const addFeed = useAddFeed();

  return useMutation(
    orpc.feed.create.mutationOptions({
      onSuccess: async (result) => {
        result.feeds.forEach((feed) => addFeed(feed));
        await Promise.all([
          fetchFeedCategories(),
          fetchViewFeeds(),
          fetchViews(),
        ]);
        await refreshNavigationSnapshotSafely();

        if (result.deactivatedCount > 0) {
          toast.warning(
            `${result.deactivatedCount} feed${result.deactivatedCount > 1 ? "s were" : " was"} added as inactive. To unlock more active feeds, you can switch to a higher plan.`,
            {
              action: {
                label: "Upgrade",
                onClick: () =>
                  useDialogStore.getState().launchDialog("subscription", {
                    subscriptionView: "picker",
                  }),
              },
            },
          );
        }
      },
    }),
  );
}

export function useDeleteFeedMutation() {
  const setFeedItemsOrder = feedItemsStore.useSetFeedItemsOrder();
  const setFeedItemsDict = feedItemsStore.useSetFeedItemsDict();

  const removeFeed = useRemoveFeed();
  const removeFeedReferences = useRemoveFeedReferences();

  return useMutation(
    orpc.feed.delete.mutationOptions({
      onSuccess: async (_, feedId) => {
        removeFeed(feedId);
        removeFeedReferences([feedId]);
        const { feedItemsDict, feedItemsOrder } = feedItemsStore.getState();

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
        await refreshNavigationSnapshotSafely();
      },
    }),
  );
}

export function useEditFeedMutation() {
  const fetchFeedCategories = useFetchFeedCategories();
  const fetchViewFeeds = useFetchViewFeeds();
  const fetchViews = useFetchViews();
  const updateFeed = useUpdateFeed();

  return useMutation(
    orpc.feed.update.mutationOptions({
      onSuccess: async (updatedFeed) => {
        if (updatedFeed) {
          updateFeed(updatedFeed.id, updatedFeed);
        }
        await Promise.all([
          fetchFeedCategories(),
          fetchViewFeeds(),
          fetchViews(),
        ]);
        await refreshNavigationSnapshotSafely();
      },
    }),
  );
}

export function useBulkDeleteFeedsMutation() {
  const setFeedItemsOrder = feedItemsStore.useSetFeedItemsOrder();
  const setFeedItemsDict = feedItemsStore.useSetFeedItemsDict();

  const fetchFeeds = useFetchFeeds();
  const fetchFeedCategories = useFetchFeedCategories();
  const removeFeedReferences = useRemoveFeedReferences();

  return useMutation(
    orpc.feed.bulkDelete.mutationOptions({
      onSuccess: async (_, { feedIds }) => {
        removeFeedReferences(feedIds);
        const { feedItemsDict, feedItemsOrder } = feedItemsStore.getState();

        // Remove feed items belonging to deleted feeds
        const feedIdSet = new Set(feedIds);
        const [updatedFeedItemsOrder, removedFeedItemIds] =
          feedItemsOrder.reduce(
            ([keptItems, removedItems], feedItemContentId) => {
              const feedItem = feedItemsDict[feedItemContentId];
              if (feedItem && feedIdSet.has(feedItem.feedId)) {
                removedItems.push(feedItemContentId);
              } else {
                keptItems.push(feedItemContentId);
              }
              return [keptItems, removedItems];
            },
            [[], []] as [string[], string[]],
          );

        const updatedFeedItemsDict = removedFeedItemIds.reduce(
          (partialMap, feedItemContentId) => {
            delete partialMap[feedItemContentId];
            return partialMap;
          },
          { ...feedItemsDict },
        );

        setFeedItemsOrder(updatedFeedItemsOrder);
        setFeedItemsDict(updatedFeedItemsDict);

        // Refetch feeds to update the list
        void fetchFeeds();
        void fetchFeedCategories();
        await refreshNavigationSnapshotSafely();
      },
    }),
  );
}

export function useSetFeedActiveMutation() {
  const updateFeed = useUpdateFeed();
  const queryClient = useQueryClient();

  return useMutation(
    orpc.feed.setActive.mutationOptions({
      onSuccess: (updatedFeed) => {
        if (updatedFeed) {
          updateFeed(updatedFeed.id, updatedFeed);
        }
        // Invalidate subscription query so active count updates
        void queryClient.invalidateQueries({
          queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
        });
      },
    }),
  );
}

export function useBulkSetActiveMutation() {
  const fetchFeeds = useFetchFeeds();
  const queryClient = useQueryClient();

  return useMutation(
    orpc.feed.bulkSetActive.mutationOptions({
      onSuccess: () => {
        void fetchFeeds();
        void queryClient.invalidateQueries({
          queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
        });
      },
    }),
  );
}

export function useRevalidateFeedMutation() {
  const updateFeed = useUpdateFeed();
  const mutationOptions = orpc.feed.revalidate.mutationOptions({
    mutationKey: REVALIDATE_FEED_MUTATION_KEY,
  });
  const revalidateFeed = mutationOptions.mutationFn;
  return useMutation(
    orpc.feed.revalidate.mutationOptions({
      mutationKey: REVALIDATE_FEED_MUTATION_KEY,
      mutationFn: async (input, context) => {
        if (revalidatingFeedIds.has(input.feedId)) {
          throw new DuplicateFeedRevalidationError();
        }
        revalidatingFeedIds.add(input.feedId);
        try {
          return await revalidateFeed!(input, context);
        } finally {
          revalidatingFeedIds.delete(input.feedId);
        }
      },
      onMutate: ({ feedId }) => feedsStore.getState().feedsDict[feedId],
      onSuccess: (feed, _input, baseline) => {
        const current = feedsStore.getState().feedsDict[feed.id];
        if (current && baseline) {
          updateFeed(feed.id, {
            origins: mergeRevalidatedOrigins(current.origins, feed.origins),
            ...(current.name === baseline.name &&
            current.nameEditedAt === baseline.nameEditedAt
              ? { name: feed.name, nameEditedAt: feed.nameEditedAt }
              : {}),
            ...(current.imageUrl === baseline.imageUrl
              ? { imageUrl: feed.imageUrl }
              : {}),
            ...(current.siteUrl === baseline.siteUrl
              ? { siteUrl: feed.siteUrl }
              : {}),
          });
        }
        toast.success("Feed revalidated");
      },
      onError: (error) => {
        if (!(error instanceof DuplicateFeedRevalidationError))
          toast.error("Couldn't revalidate Feed. Please try again.");
      },
    }),
  );
}

class DuplicateFeedRevalidationError extends Error {}

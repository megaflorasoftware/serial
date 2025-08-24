import { useTRPCClient } from "~/trpc/react";

import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const QUERY_KEYS = {
  FEEDS: "feeds",
  FEED_ITEMS: "feed-items",
  CONTENT_CATEGORIES: "content-categories",
  VIEWS: "views",
};

export type TRPCClient = ReturnType<typeof useTRPCClient>;
export type QueryClient = ReturnType<typeof useQueryClient>;

export function createFeedsCollection(
  trpcClient: TRPCClient,
  queryClient: QueryClient,
) {
  return createCollection(
    queryCollectionOptions({
      queryKey: [QUERY_KEYS.FEEDS],
      queryFn: async (data) => {
        return await trpcClient.feeds.getAll.query();
      },
      queryClient,
      getKey: (feed) => feed.id,
      onInsert: async ({ transaction }) => {
        const { modified: newFeed } = transaction.mutations[0];

        toast.promise(transaction.isPersisted.promise, {
          loading: "Adding feed...",
          success: "Feed added!",
          error: "Something went wrong adding your feed.",
        });

        await trpcClient.feeds.create.mutate(newFeed);
      },
      onUpdate: async ({ transaction }) => {
        const { modified } = transaction.mutations[0];

        toast.promise(transaction.isPersisted.promise, {
          loading: "Updating feed...",
          success: "Feed updated!",
          error: "Something went wrong updating your feed.",
        });

        await trpcClient.feeds.update.mutate(modified);
      },
      onDelete: async ({ transaction }) => {
        const { original } = transaction.mutations[0];

        toast.promise(transaction.isPersisted.promise, {
          loading: "Deleting feed...",
          success: "Feed deleted!",
          error: "Something went wrong deleting your feed.",
        });

        await trpcClient.feeds.delete.mutate(original.id);

        await queryClient.invalidateQueries({
          queryKey: [QUERY_KEYS.FEED_ITEMS],
        });
      },
    }),
  );
}

export function createFeedItemsCollection(
  trpcClient: TRPCClient,
  queryClient: QueryClient,
) {
  return createCollection(
    queryCollectionOptions({
      queryKey: [QUERY_KEYS.FEED_ITEMS],
      queryFn: async () => {
        return await trpcClient.feedItems.getAll.query();
      },
      queryClient,
      getKey: (feedItem) => feedItem.contentId,
    }),
  );
}

export function createContentCategoriesCollection(
  trpcClient: TRPCClient,
  queryClient: QueryClient,
) {
  return createCollection(
    queryCollectionOptions({
      queryKey: [QUERY_KEYS.CONTENT_CATEGORIES],
      queryFn: async () => {
        return await trpcClient.contentCategories.getAll.query();
      },
      queryClient,
      getKey: (contentCategory) => contentCategory.id,
    }),
  );
}

export function createFeedCategoriesCollection(
  trpcClient: TRPCClient,
  queryClient: QueryClient,
) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["feed-categories"],
      queryFn: async () => {
        return await trpcClient.feedCategories.getAll.query();
      },
      queryClient,
      getKey: (feedCategory) =>
        `${feedCategory.feedId}-${feedCategory.categoryId}`,
    }),
  );
}

export function createViewsCollection(
  trpcClient: TRPCClient,
  queryClient: QueryClient,
) {
  return createCollection(
    queryCollectionOptions({
      queryKey: [QUERY_KEYS.VIEWS],
      queryFn: async () => {
        return await trpcClient.views.getAll.query();
      },
      queryClient,
      getKey: (view) => view.id,
    }),
  );
}

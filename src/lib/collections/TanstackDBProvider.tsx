import { createContext, useContext } from "react";

import {
  createContentCategoriesCollection,
  createFeedCategoriesCollection,
  createFeedItemsCollection,
  createFeedsCollection,
  createFiltersCollection,
  createViewsCollection,
  type QueryClient,
  type TRPCClient,
} from ".";

interface TanstackDBContext {
  filtersCollection: ReturnType<typeof createFiltersCollection>;
  feedsCollection: ReturnType<typeof createFeedsCollection>;
  feedItemsCollection: ReturnType<typeof createFeedItemsCollection>;
  contentCategoriesCollection: ReturnType<
    typeof createContentCategoriesCollection
  >;
  feedCategoriesCollection: ReturnType<typeof createFeedCategoriesCollection>;
  viewsCollection: ReturnType<typeof createViewsCollection>;
}
export const TanstackDBContext = createContext<TanstackDBContext | null>(null);

export function TanstackDBProvider({
  trpcClient,
  queryClient,
  children,
}: {
  trpcClient: TRPCClient;
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  const filtersCollection = createFiltersCollection();
  const feedsCollection = createFeedsCollection(trpcClient, queryClient);
  const feedItemsCollection = createFeedItemsCollection(
    trpcClient,
    queryClient,
  );
  const contentCategoriesCollection = createContentCategoriesCollection(
    trpcClient,
    queryClient,
  );
  const feedCategoriesCollection = createFeedCategoriesCollection(
    trpcClient,
    queryClient,
  );
  const viewsCollection = createViewsCollection(trpcClient, queryClient);

  return (
    <TanstackDBContext.Provider
      value={{
        filtersCollection,
        feedsCollection,
        feedItemsCollection,
        contentCategoriesCollection,
        feedCategoriesCollection,
        viewsCollection,
      }}
    >
      {children}
    </TanstackDBContext.Provider>
  );
}

export function useTanstackDBContext() {
  const context = useContext(TanstackDBContext);

  if (!context) {
    throw new Error(
      "useTanstackDBContext must be called within a TanstackDBProvider.",
    );
  }

  return context;
}

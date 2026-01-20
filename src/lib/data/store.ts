import { createStore, useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { orpcRouterClient } from "../orpc";
import { sortFeedItemsOrderByDate } from "../sortFeedItems";
import { createSelectorHooks } from "./createSelectorHooks";
import { feedsStore } from "./feeds/store";
import { viewsStore } from "./views/store";
import { contentCategoriesStore } from "./content-categories/store";
import { feedCategoriesStore } from "./feed-categories/store";
import type { ApplicationFeedItem } from "~/server/db/schema";
import type { FetchFeedsStatus } from "~/server/rss/fetchFeeds";
import type {
  GetByViewChunk,
  RevalidateViewChunk,
} from "~/server/api/routers/initialRouter";

export type ApplicationStore = {
  reset: () => void;
  feedItemsOrder: string[];
  setFeedItemsOrder: (itemsOrder: string[]) => void;
  feedItemsDict: Record<string, ApplicationFeedItem>;
  feedStatusDict: Record<number, FetchFeedsStatus>;
  setFeedItemsDict: (itemsDict: Record<string, ApplicationFeedItem>) => void;
  setFeedItem: (id: string, item: ApplicationFeedItem) => void;
  fetchFeedItems: () => Promise<void>;
  fetchFeedItemsForFeed: (feedId: number) => Promise<void>;
  fetchByView: () => Promise<void>;
  revalidateView: (viewId: number) => Promise<void>;
  fetchFeedItemsLastFetchedAt: number | null;
  fetchFeedItemsStatus: "idle" | "fetching" | "success";
  hasInitialData: boolean;
  currentViewId: number | null;
  viewFeedIds: Record<number, number[]>;
  setViewFeedIds: (viewId: number, feedIds: number[]) => void;
};

const vanillaApplicationStore = createStore<ApplicationStore>()(
  // persist(
  (set, get) => ({
    reset: () =>
      set({
        feedItemsOrder: [],
        feedItemsDict: {},
        feedStatusDict: {},
        fetchFeedItemsLastFetchedAt: null,
        fetchFeedItemsStatus: "idle",
        hasInitialData: false,
        currentViewId: null,
        viewFeedIds: {},
      }),
    feedItemsOrder: [],
    setFeedItemsOrder: (itemsOrder) => set({ feedItemsOrder: itemsOrder }),
    feedItemsDict: {},
    feedStatusDict: {},
    setFeedItemsDict: (itemsDict) => set({ feedItemsDict: itemsDict }),
    setFeedItem: (id, item) =>
      set({
        feedItemsDict: {
          ...get().feedItemsDict,
          [id]: item,
        },
      }),
    fetchFeedItemsLastFetchedAt: null,
    fetchFeedItemsStatus: "idle",
    hasInitialData: false,
    currentViewId: null,
    viewFeedIds: {},
    setViewFeedIds: (viewId, feedIds) =>
      set({
        viewFeedIds: {
          ...get().viewFeedIds,
          [viewId]: feedIds,
        },
      }),

    fetchFeedItems: async () => {
      if (get().fetchFeedItemsStatus === "fetching") return;

      console.log("FETCHING");

      set({
        fetchFeedItemsStatus: "fetching",
        feedStatusDict: {},
      });

      let lastUpdateTime = 0;
      const DEBOUNCE_TIME = 1000;

      for await (const incomingChunk of await orpcRouterClient.feedItem.getAll()) {
        const timeSinceLastUpdate = Date.now() - lastUpdateTime;
        const timeToWait = DEBOUNCE_TIME - timeSinceLastUpdate;
        const shouldWaitToRender = timeToWait > 0;

        const feedStatusDict = shouldWaitToRender
          ? get().feedStatusDict
          : {
              ...get().feedStatusDict,
            };

        const feedItemsDict = shouldWaitToRender
          ? get().feedItemsDict
          : {
              ...get().feedItemsDict,
            };

        const feedItemsOrder = shouldWaitToRender
          ? get().feedItemsOrder
          : [...get().feedItemsOrder];

        if (incomingChunk.type === "feed-status") {
          feedStatusDict[incomingChunk.feedId] = incomingChunk.status;
        } else {
          const incomingFeedItems = incomingChunk.feedItems;

          incomingFeedItems.forEach((item) => {
            feedItemsDict[item.id] = item;

            if (!feedItemsOrder.find((id) => id === item.id)) {
              feedItemsOrder.push(item.id);
            }
          });
        }

        set({
          feedItemsDict: feedItemsDict,
          feedItemsOrder: feedItemsOrder.sort(
            sortFeedItemsOrderByDate(get().feedItemsDict),
          ),
          feedStatusDict: feedStatusDict,
        });

        if (!shouldWaitToRender) {
          lastUpdateTime = Date.now();
        }
      }

      set({
        fetchFeedItemsStatus: "success",
        fetchFeedItemsLastFetchedAt: Date.now(),
        feedItemsDict: { ...get().feedItemsDict },
        feedItemsOrder: [...get().feedItemsOrder].sort(
          sortFeedItemsOrderByDate(get().feedItemsDict),
        ),
        feedStatusDict: { ...get().feedStatusDict },
      });
    },

    fetchFeedItemsForFeed: async (feedId: number) => {
      set({
        fetchFeedItemsStatus: "fetching",
      });

      for await (const incomingChunk of await orpcRouterClient.feedItem.getByFeedId(
        { feedId },
      )) {
        const feedStatusDict = { ...get().feedStatusDict };
        const feedItemsDict = { ...get().feedItemsDict };
        const feedItemsOrder = [...get().feedItemsOrder];

        if (incomingChunk.type === "feed-status") {
          feedStatusDict[incomingChunk.feedId] = incomingChunk.status;
        } else {
          const incomingFeedItems = incomingChunk.feedItems;

          incomingFeedItems.forEach((item) => {
            feedItemsDict[item.id] = item;

            if (!feedItemsOrder.find((id) => id === item.id)) {
              feedItemsOrder.push(item.id);
            }
          });
        }

        set({
          feedItemsDict: feedItemsDict,
          feedItemsOrder: feedItemsOrder.sort(
            sortFeedItemsOrderByDate(get().feedItemsDict),
          ),
          feedStatusDict: feedStatusDict,
        });
      }

      set({
        fetchFeedItemsStatus: "success",
        feedItemsOrder: [...get().feedItemsOrder].sort(
          sortFeedItemsOrderByDate(get().feedItemsDict),
        ),
      });
    },

    fetchByView: async () => {
      if (get().fetchFeedItemsStatus === "fetching") return;

      set({
        fetchFeedItemsStatus: "fetching",
        feedStatusDict: {},
      });

      let lastUpdateTime = 0;
      const DEBOUNCE_TIME = 1000;

      for await (const incomingChunk of (await orpcRouterClient.initial.getAllByView()) as AsyncIterable<GetByViewChunk>) {
        const timeSinceLastUpdate = Date.now() - lastUpdateTime;
        const timeToWait = DEBOUNCE_TIME - timeSinceLastUpdate;
        const shouldWaitToRender = timeToWait > 0;

        // Handle different chunk types
        switch (incomingChunk.type) {
          case "views":
            // Set views in views store (including Uncategorized)
            viewsStore.getState().set(incomingChunk.views);
            break;

          case "feeds":
            // Set feeds in feeds store
            feedsStore.getState().set(incomingChunk.feeds);
            break;

          case "content-categories":
            // Set content categories in content categories store
            contentCategoriesStore
              .getState()
              .set(incomingChunk.contentCategories);
            break;

          case "feed-categories":
            // Set feed categories in feed categories store
            feedCategoriesStore.getState().set(incomingChunk.feedCategories);
            break;

          case "view-feeds":
            // Store the feed IDs for this view
            get().setViewFeedIds(incomingChunk.viewId, incomingChunk.feedIds);
            break;

          case "feed-status": {
            const feedStatusDict = shouldWaitToRender
              ? get().feedStatusDict
              : { ...get().feedStatusDict };

            feedStatusDict[incomingChunk.feedId] = incomingChunk.status;

            set({ feedStatusDict });

            if (!shouldWaitToRender) {
              lastUpdateTime = Date.now();
            }
            break;
          }

          case "initial-data-complete":
            // Initial data is ready - mark all stores as ready and hide loading screen
            viewsStore.setState({ fetchStatus: "success" });
            feedsStore.setState({ fetchStatus: "success" });
            contentCategoriesStore.setState({ fetchStatus: "success" });
            feedCategoriesStore.setState({ fetchStatus: "success" });
            set({ hasInitialData: true });
            break;

          case "feed-items": {
            // Track the current view ID from the first feed-items chunk
            if (get().currentViewId === null) {
              set({ currentViewId: incomingChunk.viewId });
            }

            const feedItemsDict = shouldWaitToRender
              ? get().feedItemsDict
              : { ...get().feedItemsDict };

            const feedItemsOrder = shouldWaitToRender
              ? get().feedItemsOrder
              : [...get().feedItemsOrder];

            const incomingFeedItems = incomingChunk.feedItems;

            incomingFeedItems.forEach((item) => {
              feedItemsDict[item.id] = item;

              if (!feedItemsOrder.find((id) => id === item.id)) {
                feedItemsOrder.push(item.id);
              }
            });

            set({
              feedItemsDict,
              feedItemsOrder: feedItemsOrder.sort(
                sortFeedItemsOrderByDate(get().feedItemsDict),
              ),
            });

            if (!shouldWaitToRender) {
              lastUpdateTime = Date.now();
            }
            break;
          }
        }
      }

      // Mark fetch statuses as success for all stores
      viewsStore.setState({ fetchStatus: "success" });
      feedsStore.setState({ fetchStatus: "success" });
      contentCategoriesStore.setState({ fetchStatus: "success" });
      feedCategoriesStore.setState({ fetchStatus: "success" });

      set({
        fetchFeedItemsStatus: "success",
        fetchFeedItemsLastFetchedAt: Date.now(),
        feedItemsDict: { ...get().feedItemsDict },
        feedItemsOrder: [...get().feedItemsOrder].sort(
          sortFeedItemsOrderByDate(get().feedItemsDict),
        ),
        feedStatusDict: { ...get().feedStatusDict },
      });
    },

    revalidateView: async (viewId: number) => {
      for await (const chunk of (await orpcRouterClient.initial.revalidateView({
        viewId,
      })) as AsyncIterable<RevalidateViewChunk>) {
        switch (chunk.type) {
          case "views":
            // Update views in views store
            viewsStore.getState().set(chunk.views);
            break;

          case "view-feeds":
            // Store the feed IDs for this view
            get().setViewFeedIds(chunk.viewId, chunk.feedIds);
            break;

          case "feed-items": {
            // Merge into feedItemsDict and feedItemsOrder (no reset)
            const feedItemsDict = { ...get().feedItemsDict };
            const feedItemsOrder = [...get().feedItemsOrder];

            const incomingFeedItems = chunk.feedItems;

            incomingFeedItems.forEach((item) => {
              feedItemsDict[item.id] = item;

              if (!feedItemsOrder.find((id) => id === item.id)) {
                feedItemsOrder.push(item.id);
              }
            });

            set({
              feedItemsDict,
              feedItemsOrder: feedItemsOrder.sort(
                sortFeedItemsOrderByDate(get().feedItemsDict),
              ),
            });
            break;
          }
        }
      }
    },
  }),
  //   {
  //     name: "serial", // name of the item in the storage (must be unique)
  //     version: 0,
  //     partialize: (state) => ({
  //       itemsOrder: state.feedItemsOrder,
  //       itemsDict: state.feedItemsDict,
  //       fetchItemsLastFetchedAt: state.fetchFeedItemsLastFetchedAt,
  //     }),
  //   },
  // ),
);

export const feedItemsStore = createSelectorHooks(vanillaApplicationStore);

export const {
  useFeedItemsDict,
  useFeedItemsOrder,
  useFeedStatusDict,
  useFetchFeedItemsLastFetchedAt,
  useFetchFeedItemsStatus,
  useHasInitialData,
  useFetchFeedItems,
  useFetchFeedItemsForFeed,
  useFetchByView,
  useRevalidateView,
  useCurrentViewId,
  useViewFeedIds,
  useReset: useResetFeedItems,
} = feedItemsStore;

export const useFeedItemValue = (id: string) => {
  return useStore(
    feedItemsStore,
    useShallow((store) => store.feedItemsDict[id]),
  );
};
export const useSetFeedItemValue = (id: string) => {
  const setter = useStore(feedItemsStore, (store) => store.setFeedItem);

  return (item: ApplicationFeedItem) => setter(id, item);
};

export const useFeedItemState = (id: string) => {
  const value = useFeedItemValue(id);
  const setValue = useSetFeedItemValue(id);

  return [value, setValue] as const;
};

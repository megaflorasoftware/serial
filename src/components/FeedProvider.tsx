"use client";

import {
  type Dispatch,
  type SetStateAction,
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  useCallback,
} from "react";
import { type RSSContent, type RSSFeed } from "~/server/rss/types";
import { type feeds, type feedItems } from "~/server/db/schema";
import { api } from "~/trpc/react";
import { useSearchParamState } from "~/lib/hooks/use-search-param-state";
import { z } from "zod";

export type VisibilityFilter = "all" | "unread" | "later";

type Item = typeof feedItems.$inferSelect;

type FeedContext = {
  refetch: () => void;
  feeds: (typeof feeds.$inferSelect)[];
  items: Item[];
  selectedItem: RSSContent | null;
  setSelectedItem: Dispatch<SetStateAction<RSSContent | null>>;
  dateFilter: string;
  setDateFilter: Dispatch<SetStateAction<string>>;
  visibilityFilter: VisibilityFilter;
  setVisibilityFilter: Dispatch<SetStateAction<VisibilityFilter>>;
  updateItemOptimistically: (
    item: Partial<Item> & {
      contentId: Item["contentId"];
      feedId: Item["feedId"];
    },
  ) => void;
};

const FeedContext = createContext<FeedContext | null>(null);

type FeedProviderProps = {
  children: React.ReactNode;
};

export function FeedProvider({ children }: FeedProviderProps) {
  const { data, refetch } = api.feed.getAllFeedData.useQuery();
  const [selectedItem, setSelectedItem] = useState<RSSContent | null>(null);
  const [category, setCategory] = useState<number | null>(null);

  const [dateFilter, setDateFilter] = useSearchParamState(
    "days",
    "1",
    z.string(),
  );
  const [visibilityFilter, setVisibilityFilter] = useSearchParamState(
    "visibility",
    "unread",
    z.enum(["all", "unread", "later"]),
  );

  const [unsortedItems, setUnsortedItems] = useState<Item[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const filterAndSortItems = useCallback(
    (items: Item[]) => {
      return items
        .filter((item) => {
          const date = new Date(item.postedAt);
          const now = new Date();
          const parsedDateFilter = parseInt(dateFilter, 10);
          const sevenDaysAgo = new Date(
            now.setDate(
              now.getDate() -
                (Number.isNaN(parsedDateFilter) ? 1 : parsedDateFilter),
            ),
          );
          if (date <= sevenDaysAgo) return false;

          if (
            visibilityFilter === "unread" &&
            (item.isWatched || item.isWatchLater)
          ) {
            return false;
          }
          if (visibilityFilter === "later" && !item.isWatchLater) {
            return false;
          }

          return true;
        })
        .sort((a, b) => {
          return a.postedAt > b.postedAt ? -1 : 1;
        });
    },
    [visibilityFilter, dateFilter],
  );

  useEffect(() => {
    if (!data) return;

    setUnsortedItems(data.items);
    setItems(filterAndSortItems(data.items));
  }, [data, data?.items, filterAndSortItems]);

  useEffect(() => {
    setItems(filterAndSortItems(unsortedItems));
  }, [visibilityFilter, dateFilter, filterAndSortItems, unsortedItems]);

  const updateItemOptimistically = (
    item: Partial<Item> & {
      contentId: Item["contentId"];
      feedId: Item["feedId"];
    },
  ) => {
    setUnsortedItems((_items) => {
      const updatedUnsortedItems = _items.map((i) => {
        if (i.contentId === item.contentId) {
          return { ...i, ...item };
        }
        return i;
      });

      setItems(filterAndSortItems(updatedUnsortedItems));
      return updatedUnsortedItems;
    });
  };

  return (
    <FeedContext.Provider
      value={{
        refetch: () => {
          void refetch();
        },
        feeds: data?.feeds ?? [],
        items: items ?? [],
        selectedItem,
        setSelectedItem,
        dateFilter,
        setDateFilter,
        visibilityFilter,
        setVisibilityFilter,
        updateItemOptimistically,
      }}
    >
      {children}
    </FeedContext.Provider>
  );
}

export function useFeed() {
  const context = useContext(FeedContext);

  if (!context) {
    throw new Error("useFeed must be used within a FeedProvider");
  }

  return context;
}

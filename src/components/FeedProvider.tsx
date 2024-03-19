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

export type VisibilityFilter = "all" | "unread" | "archived";

type Item = typeof feedItems.$inferSelect;

type FeedContext = {
  refetch: () => void;
  feeds: (typeof feeds.$inferSelect)[];
  items: Item[];
  selectedItem: RSSContent | null;
  setSelectedItem: Dispatch<SetStateAction<RSSContent | null>>;
  dateFilter: number;
  setDateFilter: Dispatch<SetStateAction<number>>;
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

  const [dateFilter, setDateFilter] = useState<number>(1);
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>("unread");

  const [unsortedItems, setUnsortedItems] = useState<Item[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const filterAndSortItems = useCallback(
    (items: Item[]) => {
      return items
        .filter((item) => {
          const date = new Date(item.postedAt);
          const now = new Date();
          const sevenDaysAgo = new Date(
            now.setDate(now.getDate() - dateFilter),
          );
          if (date <= sevenDaysAgo) return false;

          if (
            visibilityFilter === "unread" &&
            (item.isWatched || item.isHidden)
          ) {
            return false;
          }
          if (visibilityFilter === "archived" && !item.isHidden) {
            return false;
          }
          if (visibilityFilter === "all" && item.isHidden) {
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

"use client";

import {
  Dispatch,
  PropsWithChildren,
  SetStateAction,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import { api } from "~/trpc/server";
import { useSearchParamState } from "../hooks/use-search-param-state";
import { z } from "zod";

export type VisibilityFilter = "all" | "unread" | "later";

type FeedData = Awaited<ReturnType<typeof api.feed.getAllFeedData.query>>;
type Item = FeedData["items"][number];

type UpdateItem = (
  item: Partial<Item> & {
    contentId: Item["contentId"];
    feedId: Item["feedId"];
  },
) => void;
type FeedContext = {
  feeds: FeedData["feeds"];
  items: FeedData["items"];
  updateLocalItem: UpdateItem;
  dateFilter: string;
  setDateFilter: Dispatch<SetStateAction<string>>;
  visibilityFilter: VisibilityFilter;
  setVisibilityFilter: Dispatch<SetStateAction<VisibilityFilter>>;
};

const FeedContext = createContext<FeedContext | null>(null);

export const FeedProvider = ({
  children,
  data,
}: PropsWithChildren<{
  data: FeedData;
}>) => {
  const [feeds, setFeeds] = useState(data.feeds);
  const [items, setItems] = useState(data.items);

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

  const processedItems = useMemo(() => {
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
  }, [items, dateFilter, visibilityFilter]);

  const updateLocalItem: UpdateItem = (item) => {
    setItems((prevItems) => {
      return prevItems.map((prevItem) => {
        if (prevItem.contentId === item.contentId) {
          return { ...prevItem, ...item };
        }
        return prevItem;
      });
    });
  };

  return (
    <FeedContext.Provider
      value={{
        feeds,
        items: processedItems,
        updateLocalItem,
        dateFilter,
        setDateFilter,
        visibilityFilter,
        setVisibilityFilter,
      }}
    >
      {children}
    </FeedContext.Provider>
  );
};

export const useFeed = () => {
  const context = useContext(FeedContext);

  if (context === null) {
    throw new Error("useFeed must be used within a FeedProvider");
  }

  return context;
};

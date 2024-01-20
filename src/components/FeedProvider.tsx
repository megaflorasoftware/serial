"use client";

import {
  type Dispatch,
  type SetStateAction,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";
import { type RSSContent, type RSSFeed } from "~/server/rss/types";

type FeedContext = {
  feeds: RSSFeed[];
  items: RSSContent[];
  selectedItem: RSSContent | null;
  setSelectedItem: Dispatch<SetStateAction<RSSContent | null>>;
};

const FeedContext = createContext<FeedContext | null>(null);

type FeedProviderProps = {
  feeds: RSSFeed[];
  children: React.ReactNode;
};

export function FeedProvider({ children, feeds }: FeedProviderProps) {
  const [selectedItem, setSelectedItem] = useState<RSSContent | null>(null);

  const items = useMemo(() => {
    return feeds
      .flatMap((feed) => {
        return feed.items;
      })
      .sort((a, b) => {
        return a.publishedDate > b.publishedDate ? -1 : 1;
      });
  }, [feeds]);

  return (
    <FeedContext.Provider
      value={{ feeds, items, selectedItem, setSelectedItem }}
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

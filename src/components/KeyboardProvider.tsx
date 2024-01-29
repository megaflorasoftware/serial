"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useFeed } from "./FeedProvider";

type FeedContext = {
  view: "windowed" | "fullscreen";
  isCategoriesOpen: boolean;
  setIsCategoriesOpen: (value: boolean) => void;
};

const FeedContext = createContext<FeedContext | null>(null);

type KeyboardProviderProps = {
  children: React.ReactNode;
};

export function KeyboardProvider({ children }: KeyboardProviderProps) {
  const { items, setSelectedItem } = useFeed();
  const [view, setView] = useState<FeedContext["view"]>("windowed");
  const [isCategoriesOpen, setIsCategoriesOpen] = useState(false);

  useEffect(() => {
    const processKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "`":
          setView((prev) => {
            return prev === "windowed" ? "fullscreen" : "windowed";
          });
          break;
        case "Escape":
          setSelectedItem(null);
          break;
        case "[":
          setSelectedItem((prev) => {
            if (!prev) return null;
            const currentIndex = items.findIndex((item) => item.id === prev.id);

            if (currentIndex <= 0) return null;
            return items[currentIndex - 1]!;
          });
          break;
        case "]":
          setSelectedItem((prev) => {
            if (!prev) return null;
            const currentIndex = items.findIndex((item) => item.id === prev.id);

            if (currentIndex >= items.length - 1) return null;
            return items[currentIndex + 1]!;
          });
          break;
        // case "e":
        //   // set as watched
        //   break;
        // case "h":
        //   // set as hidden
        //   break;
        case "\\":
          setIsCategoriesOpen((prev) => !prev);
          break;
      }
    };

    window.addEventListener("keydown", processKey);

    return () => {
      window.removeEventListener("keydown", processKey);
    };
  }, [items, setSelectedItem]);

  return (
    <FeedContext.Provider
      value={{ view, isCategoriesOpen, setIsCategoriesOpen }}
    >
      {children}
    </FeedContext.Provider>
  );
}

export function useKeyboard() {
  const context = useContext(FeedContext);

  if (!context) {
    throw new Error("useKeyboard must be used within a KeyboardProvider");
  }

  return context;
}

"use client";

import { createContext, useContext, useEffect, useState } from "react";

type FeedContext = {
  view: "windowed" | "fullscreen";
};

const FeedContext = createContext<FeedContext | null>(null);

type KeyboardProviderProps = {
  children: React.ReactNode;
};

export function KeyboardProvider({ children }: KeyboardProviderProps) {
  const [view, setView] = useState<FeedContext["view"]>("windowed");

  useEffect(() => {
    const processKey = (event: KeyboardEvent) => {
      switch (event.key) {
        case "`":
          setView((prev) => {
            return prev === "windowed" ? "fullscreen" : "windowed";
          });
          break;
      }
    };

    window.addEventListener("keydown", processKey);

    return () => {
      window.removeEventListener("keydown", processKey);
    };
  }, []);

  console.log(view);

  return (
    <FeedContext.Provider value={{ view }}>{children}</FeedContext.Provider>
  );
}

export function useKeyboard() {
  const context = useContext(FeedContext);

  if (!context) {
    throw new Error("useKeyboard must be used within a KeyboardProvider");
  }

  return context;
}

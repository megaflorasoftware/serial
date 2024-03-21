"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useFeed } from "../lib/data/FeedProvider";
import { useParams, useRouter } from "next/navigation";
import { useDialogStore } from "~/app/(feed)/feed/dialogStore";
import { useRouterBackHack } from "~/lib/hooks/use-router-back-hack";

function doesAnyInputElementHaveFocus() {
  const elements = document.querySelectorAll("input, textarea, select, button");
  for (const element of elements) {
    if (element === document.activeElement) {
      return true;
    }
  }
  return false;
}

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
  const params = useParams();
  const router = useRouter();
  const goBack = useRouterBackHack();

  const { items } = useFeed();
  const [view, setView] = useState<FeedContext["view"]>("windowed");
  const [isCategoriesOpen, setIsCategoriesOpen] = useState(false);
  const { dialog, launchDialog, closeDialog } = useDialogStore((store) => ({
    dialog: store.dialog,
    launchDialog: store.launchDialog,
    closeDialog: store.closeDialog,
  }));

  useEffect(() => {
    const processKey = (event: KeyboardEvent) => {
      const videoID = params.videoID;
      const currentIndex = items.findIndex(
        (item) => item.contentId === videoID,
      );

      switch (event.key) {
        case "`":
          setView((prev) => {
            return prev === "windowed" ? "fullscreen" : "windowed";
          });
          break;
        // case "Escape":
        //   break;
        case "[":
          if (!items.length) return;

          if (event.metaKey) {
            goBack();
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
          }

          if (!videoID) {
            const previousVideo = items[items.length - 1]!;
            void router.push(`/feed/watch/${previousVideo.contentId}`);
            break;
          }

          if (currentIndex <= 0) {
            void router.push("/feed");
            break;
          }

          const previousVideo = items[currentIndex - 1]!;
          void router.push(`/feed/watch/${previousVideo.contentId}`);
          break;
        case "]":
          if (!items.length || event.metaKey) return;

          if (!videoID) {
            const previousVideo = items[0]!;
            void router.push(`/feed/watch/${previousVideo.contentId}`);
            break;
          }

          if (currentIndex >= items.length - 1 || currentIndex < 0) {
            void router.push("/feed");
            break;
          }

          const nextVideo = items[currentIndex + 1]!;
          void router.push(`/feed/watch/${nextVideo.contentId}`);
          break;
        case "a":
          if (doesAnyInputElementHaveFocus()) return;

          event.preventDefault();

          if (dialog === "add-feed") {
            closeDialog();
            break;
          }

          launchDialog("add-feed");
          break;

        // case "e":
        //   // set as watched
        //   break;
        // case "h":
        //   // set as hidden
        //   break;
        // case "\\":
        //   setIsCategoriesOpen((prev) => !prev);
        //   break;
      }
    };

    window.addEventListener("keydown", processKey);

    return () => {
      window.removeEventListener("keydown", processKey);
    };
  }, [closeDialog, dialog, items, launchDialog, params.videoID, router]);

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

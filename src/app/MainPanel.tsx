"use client";

import clsx from "clsx";
import { useFeed } from "~/components/FeedProvider";
import { useKeyboard } from "~/components/KeyboardProvider";
import ResponsiveVideo from "~/components/ResponsiveVideo";
import { ScrollArea } from "~/components/ui/scroll-area";
import TodayItems from "./TodayItems";

export default function MainPanel() {
  const { selectedItem } = useFeed();
  const { view } = useKeyboard();

  return (
    <ScrollArea className="h-full w-full">
      <div
        className={clsx(
          "flex h-full w-full flex-col items-center justify-center gap-12",
          {
            "mx-auto max-w-3xl": view === "windowed" || !selectedItem,
          },
        )}
      >
        {!selectedItem ? (
          <TodayItems />
        ) : (
          <div
            className={clsx("grid h-full w-full place-items-center", {
              "absolute inset-0 z-30 bg-black": view === "fullscreen",
            })}
          >
            <div
              className={clsx("w-full", {
                "p-6": view === "windowed",
              })}
            >
              <div
                className={clsx("w-full overflow-hidden", {
                  rounded: view === "windowed",
                })}
              >
                <ResponsiveVideo videoID={selectedItem.id} />
              </div>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

"use client";

import clsx from "clsx";
import { useFeed } from "~/components/FeedProvider";
import { useKeyboard } from "~/components/KeyboardProvider";
import ResponsiveVideo from "~/components/ResponsiveVideo";

export default function MainPanel() {
  const { selectedItem } = useFeed();
  const { view } = useKeyboard();

  if (!selectedItem) return null;

  return (
    <div
      className={clsx("grid h-full place-items-center bg-background", {
        "absolute inset-0 z-30": view === "fullscreen",
      })}
    >
      <div className="w-full">
        <ResponsiveVideo videoID={selectedItem.id} />
      </div>
    </div>
  );
}

"use client";

import clsx from "clsx";
import { useFeed } from "~/components/FeedProvider";
import { useKeyboard } from "~/components/KeyboardProvider";
import ResponsiveVideo from "~/components/ResponsiveVideo";
import TodayItems from "./TodayItems";

export default function MainPanel() {
  const { selectedItem } = useFeed();
  const { view } = useKeyboard();

  return (
    <div
      className={clsx(
        "flex h-full w-full flex-col items-center justify-center gap-12",
        {
          "mx-auto max-w-3xl": view === "windowed" || !selectedItem,
        },
      )}
    >
      <TodayItems />
    </div>
  );
}

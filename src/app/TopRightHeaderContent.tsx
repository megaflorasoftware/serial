"use client";

import { AddFeedButton } from "~/components/AddFeedButton";
import { ColorModeToggle } from "~/components/ColorModeToggle";

export function TopRightHeaderContent() {
  return (
    <div className="flex items-center gap-2">
      <AddFeedButton />
      <ColorModeToggle />
    </div>
  );
}

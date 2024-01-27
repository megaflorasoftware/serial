"use client";

import { AddFeedButton } from "~/components/AddFeedButton";
import { ColorModeToggle } from "~/components/ColorModeToggle";
import { CustomVideoButton } from "~/components/CustomVideoButton";

export function TopRightHeaderContent() {
  return (
    <div className="flex items-center gap-2">
      <AddFeedButton />
      <CustomVideoButton />
      <ColorModeToggle />
    </div>
  );
}

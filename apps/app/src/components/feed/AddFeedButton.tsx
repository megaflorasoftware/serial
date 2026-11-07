"use client";

import { useLocation } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useDialogStore } from "./dialogStore";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";
import { useCanMutate } from "~/lib/data/offline-mutations";

// The "a" shortcut itself is owned by AddFeedDialog; this button only
// displays it so a second listener never launches the dialog twice.
export function AddFeedButton() {
  const location = useLocation();
  const launchDialog = useDialogStore((store) => store.launchDialog);
  const canMutate = useCanMutate();

  if (location.pathname !== "/") return null;

  return (
    <ButtonWithShortcut
      size="icon md:default"
      variant="outline"
      onClick={() => launchDialog("add-feed")}
      disabled={!canMutate}
      shortcut="a"
      data-onboarding="add-feed"
      aria-label="Add Feed"
    >
      <PlusIcon size={16} />
      <span className="hidden pl-1.5 md:block">Add Feed</span>
    </ButtonWithShortcut>
  );
}

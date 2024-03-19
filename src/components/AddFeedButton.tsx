"use client";

import { PlusIcon } from "@radix-ui/react-icons";
import { useDialogStore } from "~/app/(feed)/dialogStore";
import { Button } from "./ui/button";

export function AddFeedButton() {
  const launchDialog = useDialogStore((store) => store.launchDialog);

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => launchDialog("add-feed")}
    >
      <PlusIcon />
    </Button>
  );
}

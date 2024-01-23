"use client";

import { UserButton } from "@clerk/nextjs";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { useFeed } from "~/components/FeedProvider";
import { Button } from "~/components/ui/button";

export function TopLeftButton() {
  const { selectedItem, setSelectedItem } = useFeed();

  if (!!selectedItem) {
    return (
      <Button
        size="icon"
        variant="outline"
        onClick={() => {
          setSelectedItem(null);
        }}
      >
        <ArrowLeftIcon />
      </Button>
    );
  }

  return (
    <div className="h-8 w-8">
      <UserButton />
    </div>
  );
}

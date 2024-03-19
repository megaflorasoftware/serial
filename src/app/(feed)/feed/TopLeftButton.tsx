"use client";

import { UserButton } from "@clerk/nextjs";
import { ArrowLeftIcon } from "@radix-ui/react-icons";
import { HomeIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFeed } from "~/components/FeedProvider";
import { Button } from "~/components/ui/button";

export function TopLeftButton() {
  const pathname = usePathname();
  const { selectedItem, setSelectedItem } = useFeed();

  if (pathname !== "/feed") {
    return (
      <Link href="/feed/">
        <Button size="icon" variant="outline">
          <HomeIcon size={16} />
        </Button>
      </Link>
    );
  }

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
    <div className="h-8 w-8 flex-shrink-0">
      <UserButton afterSignOutUrl="/" />
    </div>
  );
}

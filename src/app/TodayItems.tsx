"use client";

import { EyeOpenIcon, ArchiveIcon } from "@radix-ui/react-icons";
import dayjs from "dayjs";
import { useFeed } from "~/components/FeedProvider";
import { Button } from "~/components/ui/button";

function timeAgo(date: string) {
  const diff = dayjs().diff(date);

  if (diff < 1000 * 60) {
    return "Just now";
  }

  if (diff < 1000 * 60 * 60) {
    return `${Math.floor(diff / (1000 * 60))} minutes ago`;
  }

  if (diff < 1000 * 60 * 60 * 24) {
    return `${Math.floor(diff / (1000 * 60 * 60))} hours ago`;
  }

  return `${Math.floor(diff / (1000 * 60 * 60 * 24))} days ago`;
}

export default function TodayItems() {
  const { items, setSelectedItem } = useFeed();

  return (
    <div className="flex w-full flex-col">
      {items.map((item) => {
        return (
          <article
            className="relative flex h-24 w-full flex-1 items-center justify-stretch gap-2 border-b transition-colors"
            key={item.id}
          >
            <div className="absolute inset-y-0 right-0 flex h-full w-14 flex-col items-center justify-center pr-4">
              <Button className="w-full" size="icon" variant="ghost">
                <EyeOpenIcon />
              </Button>
              <Button className="w-full" size="icon" variant="ghost">
                <ArchiveIcon />
              </Button>
            </div>
            <button
              onClick={() => setSelectedItem(item)}
              className="flex h-24 w-full flex-1 items-center gap-4 pl-6 text-left hover:bg-accent"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.thumbnail}
                alt={item.title}
                className="h-12 w-16 rounded object-contain"
              />
              <div className="flex h-full flex-1 flex-col justify-center">
                <h3 className="max-w-xs truncate text-sm font-semibold">
                  {item.title}
                </h3>
                <p className="max-w-xs truncate text-sm opacity-50">
                  {item.author} • {timeAgo(item.publishedDate)}
                </p>
              </div>
            </button>
          </article>
        );
      })}
    </div>
  );
}

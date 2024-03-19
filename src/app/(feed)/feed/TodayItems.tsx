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
    <div className="flex w-full flex-col md:pt-4">
      {items.map((item) => {
        return (
          <article
            className="group relative flex w-full flex-1 items-center justify-stretch gap-2 md:h-20"
            key={item.id}
          >
            {/* <div className="absolute inset-y-0 right-0 hidden h-full w-24 flex-wrap items-center justify-center pr-4 group-hover:flex">
              <Button size="icon" variant="ghost">
                <ArchiveIcon />
              </Button>
              <Button size="icon" variant="ghost">
                <EyeOpenIcon />
              </Button>
            </div> */}
            <button
              onClick={() => setSelectedItem(item)}
              className="flex h-20 w-full flex-1 items-center gap-4 pl-6 pr-4 text-left transition-colors sm:hover:bg-muted md:rounded md:pr-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.thumbnail}
                alt={item.title}
                className="h-12 w-16 rounded object-contain"
              />
              <div className="flex h-full flex-1 flex-col justify-center">
                <h3 className="w-full text-sm font-semibold">{item.title}</h3>
                <p className="w-full text-sm opacity-50">
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

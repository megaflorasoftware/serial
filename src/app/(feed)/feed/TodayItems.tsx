"use client";

import dayjs from "dayjs";
import { ClockIcon, SproutIcon, EyeIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { useDialogStore } from "./dialogStore";
import clsx from "clsx";
import { useFeed } from "~/lib/data/FeedProvider";
import { useAutoAnimate } from "@formkit/auto-animate/react";

function timeAgo(date: string | Date) {
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

function TodayItemsEmptyState() {
  return (
    <div className="w-full px-6 md:py-6">
      <div className="flex w-full flex-col items-center justify-center rounded bg-muted p-12">
        <SproutIcon size={40} />
        <h2 className="pt-2 text-lg font-semibold">
          You&apos;ve seen everything!
        </h2>
        <p className="max-w-xs pt-1 text-center text-sm opacity-80">
          Take a walk, buy a sweet treat, or do something else that will make
          you happy today.
        </p>
      </div>
    </div>
  );
}

function TodayItemsFeedEmptyState() {
  const launchDialog = useDialogStore((store) => store.launchDialog);

  return (
    <button
      className="w-full px-6 md:py-6"
      onClick={() => launchDialog("add-feed")}
    >
      <div className="flex w-full flex-col items-center justify-center rounded bg-muted p-12">
        <PlusIcon size={40} />
        <h2 className="pt-2 text-lg font-semibold">Add a feed</h2>
        <p className="max-w-xs pt-1 text-center text-sm opacity-80">
          It all starts with a feed! Click here to add one.
        </p>
      </div>
    </button>
  );
}

function ItemDisplay({
  item,
}: {
  item: ReturnType<typeof useFeed>["items"][0];
}) {
  const { toggleWatchLater, toggleIsWatched } = useFeed();

  return (
    <article
      className={clsx(
        "group relative flex w-full flex-1 items-center justify-stretch gap-2 md:h-20",
        {
          "opacity-50": item.isWatched,
        },
      )}
      key={item.contentId}
    >
      <Link
        href={`/feed/watch/${item.contentId}`}
        className="flex w-full flex-1 flex-col gap-4 py-4 pl-6 pr-4 text-left transition-colors sm:hover:bg-muted md:h-20 md:flex-row md:items-center md:rounded md:py-0 md:pr-0"
        prefetch
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.thumbnail}
          alt={item.title}
          className="aspect-video w-16 rounded object-cover"
        />
        <div className="flex h-full flex-1 flex-col justify-center">
          <h3 className="w-full text-xs font-semibold md:text-sm">
            {item.title}
          </h3>
          <p className="w-full text-xs opacity-80 md:text-sm">
            {item.author} • {timeAgo(item.postedAt)}
          </p>
        </div>
      </Link>
      <div className="flex h-full flex-row flex-wrap items-center justify-center pr-6 md:pr-0">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            void toggleWatchLater(item.contentId);
          }}
        >
          <ClockIcon size={16} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            void toggleIsWatched(item.contentId);
          }}
        >
          <EyeIcon size={16} />
        </Button>
      </div>
    </article>
  );
}

export function TodayItems() {
  const { items, feeds } = useFeed();
  const [parent] = useAutoAnimate(/* optional config */);

  if (feeds.length === 0) {
    return <TodayItemsFeedEmptyState />;
  }

  if (items.length === 0) {
    return <TodayItemsEmptyState />;
  }

  return (
    <div className="w-full md:pt-4" ref={parent}>
      {items.map((item) => (
        <ItemDisplay item={item} key={item.contentId} />
      ))}
    </div>
  );
}

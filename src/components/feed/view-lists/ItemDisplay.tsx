"use client";

import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { CheckIcon, ClockIcon, EyeIcon, SendIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  useFeedItemsSetWatchedValueMutation,
  useFeedItemsSetWatchLaterValueMutation,
} from "~/lib/data/feed-items/mutations";
import { useFeeds as useFeedsArray } from "~/lib/data/feeds/store";
import {
  useInstapaperConnectionStatus,
  useSaveToInstapaperMutation,
} from "~/lib/data/instapaper";
import { useFeedItemValue } from "~/lib/data/store";
import { timeAgo } from "~/lib/utils";

export type ItemSize = "standard" | "large";

interface ItemDisplayProps {
  contentId: string;
  size?: ItemSize;
}

export function ItemDisplay({
  contentId,
  size = "standard",
}: ItemDisplayProps) {
  const feeds = useFeedsArray();
  const item = useFeedItemValue(contentId);

  const { mutateAsync: setWatchedValue } =
    useFeedItemsSetWatchedValueMutation(contentId);
  const { mutateAsync: setWatchLaterValue } =
    useFeedItemsSetWatchLaterValueMutation(contentId);

  const { data: instapaperStatus } = useInstapaperConnectionStatus();
  const { mutateAsync: saveToInstapaper, isPending: isSavingToInstapaper } =
    useSaveToInstapaperMutation(contentId);

  if (!item) return null;

  const feed = feeds.find((f) => f.id === item.feedId);

  const itemDestination = item.platform === "website" ? "read" : "watch";

  const shouldOpenInSerial =
    feed?.openLocation === "serial" || !feed?.openLocation;

  const href = shouldOpenInSerial ? `/${itemDestination}/${item.id}` : item.url;

  const target = shouldOpenInSerial ? undefined : "_blank";
  const rel = shouldOpenInSerial ? undefined : "noopener noreferrer";

  const isLarge = size === "large";

  return (
    <article
      className={clsx(
        "group relative flex w-full flex-1 items-center justify-stretch gap-2",
        !isLarge && "md:h-20",
        {
          "opacity-50": item.isWatched,
        },
      )}
    >
      <Link
        to={href}
        target={target}
        rel={rel}
        preload={shouldOpenInSerial ? "viewport" : undefined}
        className={clsx(
          "sm:hover:bg-muted flex w-full flex-1 flex-col gap-4 py-4 pr-4 pl-6 text-left transition-colors md:flex-row md:items-center md:rounded md:pr-0",
          !isLarge && "md:h-20 md:py-0",
        )}
      >
        {isLarge ? (
          <>
            <div className="relative h-28 w-44 flex-shrink-0">
              {item.thumbnail ? (
                <>
                  <img
                    src={item.thumbnail}
                    alt={item.title}
                    className="h-full w-full rounded object-cover"
                  />
                  {item.platform === "website" && (
                    <div className="absolute inset-0 rounded bg-foreground/30 dark:bg-background/30" />
                  )}
                  {feed?.imageUrl && (
                    <img
                      src={feed.imageUrl}
                      alt={feed.name}
                      className="bg-background dark:bg-foreground absolute top-2 left-2 z-10 h-10 aspect-square rounded object-contain p-1 shadow-md"
                    />
                  )}
                </>
              ) : feed?.imageUrl ? (
                <div className="bg-muted grid h-full w-full place-items-center rounded">
                  <img
                    src={feed.imageUrl}
                    alt={feed.name}
                    className="h-10 w-10 rounded object-contain"
                  />
                </div>
              ) : (
                <div className="bg-muted h-full w-full rounded" />
              )}
            </div>
            <div className="flex h-full flex-1 flex-col justify-center pr-2">
              <h3 className="line-clamp-2 w-full text-xs font-semibold md:text-sm">
                {item.title}
              </h3>
              <p className="line-clamp-2 w-full pt-1 text-xs opacity-60 md:text-sm">
                {item.contentSnippet}
              </p>
              <p className="w-full pt-1 text-xs opacity-80 md:text-sm">
                {item.author || feed?.name} • {timeAgo(item.postedAt)}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="grid size-16 place-items-center">
              {feed?.imageUrl ? (
                <img
                  src={feed.imageUrl}
                  alt={feed.name}
                  className="h-8 aspect-square rounded object-contain"
                />
              ) : (
                <div className="bg-muted h-8 aspect-square rounded" />
              )}
            </div>
            <div className="flex h-full flex-1 flex-col justify-center">
              <h3 className="line-clamp-1 w-full text-xs font-semibold md:text-sm">
                {item.title}
              </h3>
              <p className="w-full text-xs opacity-80 md:text-sm">
                {item.author || feed?.name} • {timeAgo(item.postedAt)}
              </p>
            </div>
          </>
        )}
      </Link>
      <div className="flex h-full flex-row flex-wrap items-center justify-center pr-6 md:pr-0">
        {instapaperStatus?.isConfigured &&
          instapaperStatus.isConnected &&
          item.platform === "website" && (
            <Button
              size="icon"
              variant="ghost"
              disabled={isSavingToInstapaper}
              onClick={() => {
                void saveToInstapaper({ feedItemId: item.id });
              }}
            >
              <SendIcon size={16} />
            </Button>
          )}
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            void setWatchLaterValue({
              id: item.id,
              feedId: item.feedId,
              isWatchLater: !item.isWatchLater,
            });
          }}
        >
          {item.isWatchLater ? (
            <CheckIcon size={16} />
          ) : (
            <ClockIcon size={16} />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            void setWatchedValue({
              id: item.id,
              feedId: item.feedId,
              isWatched: !item.isWatched,
            });
          }}
        >
          <EyeIcon size={16} />
        </Button>
      </div>
    </article>
  );
}

interface GridItemDisplayProps {
  contentId: string;
  size?: ItemSize;
}

export function GridItemDisplay({
  contentId,
  size = "standard",
}: GridItemDisplayProps) {
  const feeds = useFeedsArray();
  const item = useFeedItemValue(contentId);

  const { mutateAsync: setWatchedValue } =
    useFeedItemsSetWatchedValueMutation(contentId);
  const { mutateAsync: setWatchLaterValue } =
    useFeedItemsSetWatchLaterValueMutation(contentId);

  const { data: instapaperStatus } = useInstapaperConnectionStatus();
  const { mutateAsync: saveToInstapaper, isPending: isSavingToInstapaper } =
    useSaveToInstapaperMutation(contentId);

  if (!item) return null;

  const feed = feeds.find((f) => f.id === item.feedId);

  const itemDestination = item.platform === "website" ? "read" : "watch";

  const shouldOpenInSerial =
    feed?.openLocation === "serial" || !feed?.openLocation;

  const href = shouldOpenInSerial ? `/${itemDestination}/${item.id}` : item.url;

  const target = shouldOpenInSerial ? undefined : "_blank";
  const rel = shouldOpenInSerial ? undefined : "noopener noreferrer";

  const isLarge = size === "large";

  return (
    <article
      className={clsx("group relative flex w-full flex-col", {
        "opacity-50": item.isWatched,
      })}
    >
      <Link
        to={href}
        target={target}
        rel={rel}
        preload={shouldOpenInSerial ? "viewport" : undefined}
        className="sm:hover:bg-muted flex w-full flex-col rounded p-2 text-left transition-colors"
      >
        <div
          className={clsx(
            "relative w-full rounded",
            item.thumbnail
              ? item.orientation === "vertical"
                ? "aspect-[9/16]"
                : "aspect-video"
              : "bg-muted grid aspect-square place-items-center",
          )}
        >
          {item.thumbnail && (
            <img
              src={item.thumbnail}
              alt={item.title}
              className="absolute inset-0 h-full w-full rounded object-cover"
            />
          )}
          {item.thumbnail && item.platform === "website" && (
            <div className="absolute inset-0 rounded bg-foreground/30 dark:bg-background/30" />
          )}
          {feed?.imageUrl && (
            <img
              src={feed.imageUrl}
              alt={feed.name}
              className={clsx(
                "aspect-square rounded object-contain",
                item.thumbnail
                  ? "bg-background dark:bg-foreground absolute top-2 right-2 z-10 h-10 p-1 shadow-md"
                  : "w-1/2",
              )}
            />
          )}
        </div>
        <div className="flex flex-1 flex-col justify-center pt-2">
          {isLarge ? (
            <>
              <h3 className="line-clamp-1 w-full text-sm font-semibold">
                {item.title}
              </h3>
              {item.contentSnippet && (
                <p className="line-clamp-2 w-full pt-1 text-xs opacity-60">
                  {item.contentSnippet}
                </p>
              )}
              <p className="w-full pt-0.5 text-sm opacity-80">
                {item.author || feed?.name} • {timeAgo(item.postedAt)}
              </p>
            </>
          ) : (
            <>
              <h3 className="line-clamp-2 w-full text-xs font-semibold md:text-sm">
                {item.title}
              </h3>
              <p className="w-full pt-0.5 text-xs opacity-80 md:text-sm">
                {item.author || feed?.name} • {timeAgo(item.postedAt)}
              </p>
            </>
          )}
        </div>
      </Link>
      <div className="flex flex-row items-center justify-start gap-1 px-2 pb-2">
        {instapaperStatus?.isConfigured &&
          instapaperStatus.isConnected &&
          item.platform === "website" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={isSavingToInstapaper}
              onClick={() => {
                void saveToInstapaper({ feedItemId: item.id });
              }}
              className="h-8 w-8 p-0"
            >
              <SendIcon size={14} />
            </Button>
          )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void setWatchLaterValue({
              id: item.id,
              feedId: item.feedId,
              isWatchLater: !item.isWatchLater,
            });
          }}
          className="h-8 w-8 p-0"
        >
          {item.isWatchLater ? (
            <CheckIcon size={14} />
          ) : (
            <ClockIcon size={14} />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void setWatchedValue({
              id: item.id,
              feedId: item.feedId,
              isWatched: !item.isWatched,
            });
          }}
          className="h-8 w-8 p-0"
        >
          <EyeIcon size={14} />
        </Button>
      </div>
    </article>
  );
}

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

// Typography components for consistent styling across layouts

interface ItemTitleProps {
  title: string;
  lineClamp?: 1 | 2;
}

function ItemTitle({ title, lineClamp = 2 }: ItemTitleProps) {
  return (
    <h3
      className={clsx(
        "w-full text-xs font-semibold md:text-sm",
        lineClamp === 1 ? "line-clamp-1" : "line-clamp-2",
      )}
    >
      {title}
    </h3>
  );
}

interface ItemContentSnippetProps {
  snippet: string | undefined;
}

function ItemContentSnippet({ snippet }: ItemContentSnippetProps) {
  if (!snippet) return null;

  return (
    <p className="line-clamp-2 w-full pt-1 text-xs opacity-60 md:text-sm">
      {snippet.slice(0, 150)}
    </p>
  );
}

interface ItemMetaProps {
  author: string | undefined;
  feedName: string | undefined;
  postedAt: Date;
  className?: string;
}

function ItemMeta({ author, feedName, postedAt, className }: ItemMetaProps) {
  return (
    <p className={clsx("w-full text-xs opacity-80 md:text-sm", className)}>
      {author || feedName} • {timeAgo(postedAt)}
    </p>
  );
}

// Thumbnail components for consistent styling across layouts

type ThumbnailType =
  | "horizontal-video"
  | "vertical-video"
  | "article"
  | "icon"
  | "none";

function getThumbnailType(
  item: {
    thumbnail?: string;
    platform: string;
    orientation?: string;
  },
  feed?: { imageUrl?: string },
  layout?: ThumbnailLayout,
): ThumbnailType {
  if (item.thumbnail) {
    // Standard list uses icon style for non-video content
    if (item.platform === "website") {
      return layout === "list" ? (feed?.imageUrl ? "icon" : "none") : "article";
    }
    if (item.orientation === "vertical") return "vertical-video";
    return "horizontal-video";
  }
  if (feed?.imageUrl) return "icon";
  return "none";
}

type ThumbnailLayout = "list" | "large-list" | "grid" | "large-grid";

interface ThumbnailContainerProps {
  layout: ThumbnailLayout;
  thumbnailType: ThumbnailType;
  children: React.ReactNode;
}

function ThumbnailContainer({
  layout,
  thumbnailType,
  children,
}: ThumbnailContainerProps) {
  const isVideo =
    thumbnailType === "horizontal-video" || thumbnailType === "vertical-video";

  return (
    <div
      className={clsx("relative flex-shrink-0 overflow-hidden rounded", {
        // List layout: videos use natural aspect ratio, others use square
        "h-9 w-16": layout === "list" && thumbnailType === "horizontal-video",
        "h-16 w-9": layout === "list" && thumbnailType === "vertical-video",
        "size-16":
          layout === "list" &&
          (thumbnailType === "icon" || thumbnailType === "none"),
        // Large list layout
        "aspect-video w-44":
          layout === "large-list" && thumbnailType === "horizontal-video",
        "aspect-[9/16] w-20":
          layout === "large-list" && thumbnailType === "vertical-video",
        "bg-muted aspect-[3/2] w-44": layout === "large-list" && !isVideo,
        // Grid layout (standard)
        "aspect-video w-full":
          (layout === "grid" || layout === "large-grid") &&
          thumbnailType === "horizontal-video",
        "aspect-[9/16] w-full":
          (layout === "grid" || layout === "large-grid") &&
          thumbnailType === "vertical-video",
        // Non-video grid layouts
        "aspect-[3/2] w-full":
          (layout === "grid" || layout === "large-grid") && !isVideo,
      })}
    >
      {children}
    </div>
  );
}

interface ThumbnailProps {
  thumbnail: string;
  title: string;
}

function VideoThumbnail({ thumbnail, title }: ThumbnailProps) {
  return (
    <img
      src={thumbnail}
      alt={title}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

function ShortsThumbnail({ thumbnail, title }: ThumbnailProps) {
  return (
    <img
      src={thumbnail}
      alt={title}
      className="absolute inset-0 h-full w-full object-cover"
    />
  );
}

interface ArticleThumbnailProps {
  thumbnail: string;
  title: string;
  feedImageUrl?: string;
  feedName?: string;
}

function ArticleThumbnail({
  thumbnail,
  title,
  feedImageUrl,
  feedName,
}: ArticleThumbnailProps) {
  return (
    <>
      <img
        src={thumbnail}
        alt={title}
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="bg-foreground/30 dark:bg-background/30 absolute inset-0" />
      {feedImageUrl && (
        <img
          src={feedImageUrl}
          alt={feedName}
          className="bg-background dark:bg-foreground absolute top-2 left-2 z-10 h-10 w-10 rounded object-contain p-1 shadow-md"
        />
      )}
    </>
  );
}

interface IconThumbnailProps {
  feedImageUrl: string;
  feedName?: string;
}

function IconThumbnail({ feedImageUrl, feedName }: IconThumbnailProps) {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <img
        src={feedImageUrl}
        alt={feedName}
        className="h-10 w-10 rounded object-contain"
      />
    </div>
  );
}

function EmptyThumbnail() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-transparent">
      <div className="bg-muted-foreground/20 h-10 w-10 rounded" />
    </div>
  );
}

interface ItemThumbnailProps {
  layout: ThumbnailLayout;
  item: {
    thumbnail?: string;
    title: string;
    platform: string;
    orientation?: string;
  };
  feed?: {
    imageUrl?: string;
    name?: string;
  };
}

function ItemThumbnail({ layout, item, feed }: ItemThumbnailProps) {
  const thumbnailType = getThumbnailType(item, feed, layout);

  return (
    <ThumbnailContainer layout={layout} thumbnailType={thumbnailType}>
      {thumbnailType === "horizontal-video" && (
        <VideoThumbnail thumbnail={item.thumbnail!} title={item.title} />
      )}
      {thumbnailType === "vertical-video" && (
        <ShortsThumbnail thumbnail={item.thumbnail!} title={item.title} />
      )}
      {thumbnailType === "article" && (
        <ArticleThumbnail
          thumbnail={item.thumbnail!}
          title={item.title}
          feedImageUrl={feed?.imageUrl}
          feedName={feed?.name}
        />
      )}
      {thumbnailType === "icon" && (
        <IconThumbnail feedImageUrl={feed!.imageUrl!} feedName={feed?.name} />
      )}
      {thumbnailType === "none" && <EmptyThumbnail />}
    </ThumbnailContainer>
  );
}

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
        "group relative flex w-full flex-1 justify-stretch gap-2",
        isLarge
          ? "flex-col md:flex-row md:items-center"
          : "items-center md:h-20",
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
          "sm:hover:bg-muted flex w-full flex-1 flex-col gap-4 pt-4 pr-4 pl-6 text-left transition-colors md:flex-row md:items-center md:rounded md:py-4 md:pr-0",
          isLarge ? "pb-1 md:pb-4" : "pb-4 md:h-20 md:py-0",
        )}
      >
        {isLarge ? (
          <>
            <div className="grid w-44 place-items-center">
              <ItemThumbnail layout="large-list" item={item} feed={feed} />
            </div>
            <div className="flex h-full flex-1 flex-col justify-center pr-2">
              <ItemTitle title={item.title} lineClamp={2} />
              <ItemContentSnippet snippet={item.contentSnippet} />
              <ItemMeta
                author={item.author}
                feedName={feed?.name}
                postedAt={item.postedAt}
                className="pt-1"
              />
            </div>
          </>
        ) : (
          <>
            <div className="grid w-16 place-items-center">
              <ItemThumbnail layout="list" item={item} feed={feed} />
            </div>
            <div className="flex h-full flex-1 flex-col justify-center">
              <ItemTitle title={item.title} lineClamp={1} />
              <ItemMeta
                author={item.author}
                feedName={feed?.name}
                postedAt={item.postedAt}
              />
            </div>
          </>
        )}
      </Link>
      <div
        className={clsx(
          "flex flex-row flex-wrap items-center",
          isLarge
            ? "justify-start pb-2 pl-6 md:h-full md:justify-center md:pr-0 md:pb-0 md:pl-0"
            : "h-full justify-center pr-6 md:pr-0",
        )}
      >
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
        className={clsx(
          "sm:hover:bg-muted flex flex-col rounded p-2 text-left transition-colors",
          {
            "w-full": !isLarge,
            "w-[calc(100vw-3rem)] md:w-full": isLarge,
          },
        )}
      >
        <ItemThumbnail
          layout={isLarge ? "large-grid" : "grid"}
          item={item}
          feed={feed}
        />
        <div className="flex flex-1 flex-col justify-center pt-2">
          <ItemTitle title={item.title} lineClamp={isLarge ? 1 : 2} />
          {isLarge && <ItemContentSnippet snippet={item.contentSnippet} />}
          <ItemMeta
            author={item.author}
            feedName={feed?.name}
            postedAt={item.postedAt}
            className="pt-0.5"
          />
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

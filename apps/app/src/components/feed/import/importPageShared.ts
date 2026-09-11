import type { Dispatch, SetStateAction } from "react";
import type { ImportFeedDataItem } from "./utils/shared";
import type { useFeeds } from "~/lib/data/feeds";
import type { useImportResults } from "~/lib/data/loading-machine";

export type UserFeeds = ReturnType<typeof useFeeds>["feeds"];
export type FailedImportUrls = ReturnType<
  typeof useImportResults
>["failedImportUrls"];
export type SetFeedsFoundFromFile = Dispatch<
  SetStateAction<ImportFeedDataItem[] | null>
>;

export function getFeedWebsiteUrl(feed: ImportFeedDataItem) {
  if (feed.websiteUrl) return feed.websiteUrl;

  try {
    return new URL(feed.feedUrl).origin;
  } catch {
    return feed.feedUrl;
  }
}

export function compareImportTitles(
  a: ImportFeedDataItem,
  b: ImportFeedDataItem,
) {
  if (!a.title && !b.title) return 0;
  if (!a.title) return -1;
  if (!b.title) return -1;
  return a.title.localeCompare(b.title);
}

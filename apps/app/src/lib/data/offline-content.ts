import {
  hasContentRevisionChanged,
  hasReaderBodyContent,
} from "./feed-items/readerBody";
import type { ApplicationFeedItem } from "~/server/db/schema";
import type { ApplicationBookmark } from "~/server/mixed-content/projection";
import type { ConnectionState } from "./atoms";

export function isEligibleFeedBody(
  item: Pick<ApplicationFeedItem, "body" | "contentType" | "isWatched">,
) {
  return (
    item.contentType === "text" &&
    !item.isWatched &&
    hasReaderBodyContent(item.body)
  );
}

export function hasRetainedFeedBody(
  item: Pick<ApplicationFeedItem, "body" | "contentType" | "isWatched">,
  isRetained: boolean,
) {
  return isRetained && isEligibleFeedBody(item);
}

export function retainEligibleFeedBody(
  previousItem: ApplicationFeedItem | undefined,
  nextItem: ApplicationFeedItem,
) {
  if (nextItem.contentType !== "text" || nextItem.isWatched) {
    return nextItem;
  }
  // List rows never carry a body; keep the loaded one unless the revision moved.
  if (
    !hasReaderBodyContent(nextItem.body) &&
    previousItem &&
    !hasContentRevisionChanged(previousItem, nextItem) &&
    isEligibleFeedBody(previousItem)
  ) {
    return {
      ...nextItem,
      body: previousItem.body,
      contentSnippet: nextItem.contentSnippet || previousItem.contentSnippet,
    };
  }
  return nextItem;
}

// Memoized per entity object so repeated persistence flushes hand the
// normalized IDB diff a stable stripped identity instead of a fresh clone.
const strippedBodiesForPersistence = new WeakMap<
  ApplicationFeedItem,
  ApplicationFeedItem
>();

/**
 * Archived and video bodies must not survive in client persistence. The live
 * store keeps them so the online reader can render without a refetch; only
 * the persisted snapshot is stripped.
 */
export function stripIneligibleFeedBodyForPersistence(
  item: ApplicationFeedItem,
) {
  if (isEligibleFeedBody(item) || item.body === null) return item;
  let stripped = strippedBodiesForPersistence.get(item);
  if (!stripped) {
    stripped = { ...item, body: null };
    strippedBodiesForPersistence.set(item, stripped);
  }
  return stripped;
}

export function shouldRetainBookmarkCapture(
  bookmark: Pick<ApplicationBookmark, "contentType" | "isRead" | "isSaved">,
) {
  return (
    bookmark.contentType === "text" && bookmark.isSaved && !bookmark.isRead
  );
}

export function canOpenOfflineContent(input: {
  contentType: "text" | "video";
  hasBody: boolean;
}) {
  return input.contentType === "text" && input.hasBody;
}

export function canOpenContent(input: {
  connectionState: ConnectionState;
  contentType: "text" | "video";
  hasBody: boolean;
}) {
  return (
    input.connectionState !== "disconnected" || canOpenOfflineContent(input)
  );
}

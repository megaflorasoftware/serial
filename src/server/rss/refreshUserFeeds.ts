import { publisher } from "../api/publisher";
import { captureException } from "../logger";
import { fetchAndInsertFeedData } from "./fetchFeeds";
import type { PublishedChunk } from "../api/publisher";
import type { GetByViewChunk } from "../api/routers/initialRouter";
import type { ApplicationFeedItem, DatabaseFeed } from "../db/schema";
import type { db as Database } from "../db";
import type { FetchFeedsStatus } from "./fetchFeeds";

export type RefreshStats = {
  refreshedCount: number;
  skippedCount: number;
  emptyCount: number;
  errorCount: number;
  totalRowsWritten: number;
};

type RefreshSource = "initial" | "new-data";

/**
 * Shared feed refresh logic used by both background-refresh tasks and
 * interactive user-triggered refreshes. Fetches RSS content for the
 * given feeds and optionally publishes progress/results via the SSE
 * publisher for any active subscribers.
 *
 * @param channel  - If provided, publishes refresh-start, feed-status,
 *                   and feed-items chunks to this SSE channel.
 * @param source   - The PublishedChunk source label ("initial" or "new-data").
 * @param onFeedItems - Optional callback invoked with each successful feed's
 *                      items, allowing callers to apply per-view filtering.
 *                      If omitted, all items are published as-is.
 */
export async function refreshUserFeeds({
  db,
  feedsList,
  channel,
  source = "initial",
  onFeedItems,
}: {
  db: typeof Database;
  feedsList: DatabaseFeed[];
  channel?: string;
  source?: RefreshSource;
  onFeedItems?: (
    feedResult: {
      id: number;
      feedItems: ApplicationFeedItem[];
      status: FetchFeedsStatus;
    },
    publish: (chunk: GetByViewChunk) => Promise<void>,
  ) => Promise<void>;
}): Promise<RefreshStats> {
  const now = new Date();

  // Only refresh feeds that are actually due
  const activeFeedsList = feedsList.filter((feed) => feed.isActive);
  const feedsToFetch = activeFeedsList.filter(
    (feed) => !feed.nextFetchAt || feed.nextFetchAt <= now,
  );

  const stats: RefreshStats = {
    refreshedCount: 0,
    skippedCount: 0,
    emptyCount: 0,
    errorCount: 0,
    totalRowsWritten: 0,
  };

  if (feedsToFetch.length === 0) {
    return stats;
  }

  // Typed publish helper that no-ops when there is no channel
  const publish = channel
    ? async (chunk: GetByViewChunk) => {
        await publisher.publish(`${channel}`, {
          source,
          chunk,
        } as PublishedChunk);
      }
    : async () => {};

  await publish({ type: "refresh-start", totalFeeds: feedsToFetch.length });

  // Build feed name map for error logging
  const feedNameMap = new Map<number, string>();
  for (const feed of activeFeedsList) {
    feedNameMap.set(feed.id, feed.name);
  }

  for await (const feedResult of fetchAndInsertFeedData(
    { db },
    activeFeedsList,
  )) {
    // Skip publishing status for cached feeds (they complete instantly)
    if (feedResult.status === "skipped") {
      stats.skippedCount++;
      continue;
    }

    // Publish feed status for actual fetches
    await publish({
      type: "feed-status",
      status: feedResult.status,
      feedId: feedResult.id,
    });

    if (feedResult.status === "success") {
      stats.refreshedCount++;
      if ("feedItems" in feedResult) {
        stats.totalRowsWritten += feedResult.feedItems.length;

        // If caller provided custom item handling (e.g., per-view filtering), use it.
        // Otherwise publish all items directly.
        if (feedResult.feedItems.length > 0) {
          if (onFeedItems) {
            await onFeedItems(
              {
                id: feedResult.id,
                feedItems: feedResult.feedItems,
                status: feedResult.status,
              },
              publish,
            );
          } else {
            await publish({
              type: "feed-items",
              feedId: feedResult.id,
              feedItems: feedResult.feedItems,
            });
          }
        }
      }
    } else if (feedResult.status === "empty") {
      stats.emptyCount++;
    } else if (feedResult.status === "error") {
      stats.errorCount++;
      const feedName = feedNameMap.get(feedResult.id) ?? "unknown";
      const errMsg =
        "error" in feedResult
          ? feedResult.error instanceof Error
            ? feedResult.error.message
            : String(feedResult.error)
          : "Unknown error";
      captureException(
        "error" in feedResult && feedResult.error instanceof Error
          ? feedResult.error
          : new Error(errMsg),
        { feedId: feedResult.id, feedName },
      );
    }
  }

  return stats;
}

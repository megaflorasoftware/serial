import { publisher } from "../api/publisher";
import { captureException } from "../logger";
import { fetchAndInsertFeedData } from "./fetchFeeds";
import { affectedFeedFromItems, emptyRefreshStats } from "./stats";
import type { FetchableOrigin } from "./types";
import type { db as Database } from "../db";
import type { RefreshStats } from "./stats";
import type { RssPublishedChunk } from "~/lib/rss";

export type { RefreshStats } from "./stats";

/**
 * Shared feed refresh logic used by both background-refresh tasks and
 * interactive user-triggered refreshes. Fetches content for the given
 * origins and publishes feed-status / feed-items chunks via the SSE
 * publisher for any active subscribers. Each origin result yields one
 * chunk and one stats increment, addressed by the owning Feed's id; a Feed
 * with two origins therefore reports twice, which ticket 07 revisits.
 *
 * Callers are responsible for publishing `refresh-start` before and
 * `refresh-complete` after calling this function.
 *
 * @param channel  - If provided, publishes feed-status and feed-items
 *                   chunks to this SSE channel.
 */
export async function refreshUserFeeds({
  db,
  feedsList,
  channel,
}: {
  db: typeof Database;
  feedsList: FetchableOrigin[];
  channel?: string;
}): Promise<RefreshStats> {
  const activeOrigins = feedsList.filter(({ feed }) => feed.isActive);

  const stats = emptyRefreshStats();

  if (activeOrigins.length === 0) {
    return stats;
  }

  // Typed publish helper that no-ops when there is no channel
  const publish = channel
    ? async (chunk: RssPublishedChunk) => {
        await publisher.publish(`${channel}`, {
          source: "rss",
          chunk,
        });
      }
    : async () => {};

  // Build feed name map for error logging
  const feedNameMap = new Map<number, string>();
  for (const { feed } of activeOrigins) {
    feedNameMap.set(feed.id, feed.name);
  }

  for await (const feedResult of fetchAndInsertFeedData(
    { db },
    activeOrigins,
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
        const affectedFeed = affectedFeedFromItems(
          feedResult.id,
          feedResult.feedItems,
        );
        if (affectedFeed) stats.affectedFeeds.push(affectedFeed);

        if (feedResult.feedItems.length > 0) {
          await publish({
            type: "feed-items",
            feedId: feedResult.id,
            feedItems: feedResult.feedItems,
          });
        }
      }
    } else if (feedResult.status === "empty") {
      stats.emptyCount++;
    } else if (feedResult.status === "error") {
      stats.errorCount++;
      stats.originFailureFeedIds.push(feedResult.id);
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
        { feedId: feedResult.id, originId: feedResult.originId, feedName },
      );
    }
  }

  return stats;
}

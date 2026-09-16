import { publisher } from "../api/publisher";
import { captureException } from "../logger";
import { fetchAndInsertFeedData } from "./fetchFeeds";
import { affectedFeedFromItems, emptyRefreshStats } from "./stats";
import type { FeedResult } from "./fetchFeeds";
import type { FetchableOrigin } from "./types";
import type { db as Database } from "../db";
import type { RefreshStats } from "./stats";
import type { RssPublishedChunk } from "~/lib/rss";

export type { RefreshStats } from "./stats";

/**
 * Shared feed refresh logic used by both background-refresh tasks and
 * interactive user-triggered refreshes. Fetches content for the given
 * origins and publishes feed-status / feed-items chunks via the SSE
 * publisher for any active subscribers. Item writes publish as they commit;
 * a Feed reports completion once all its due origins finish. The due pager
 * keeps a Feed's origins together, with at most two origins per Feed.
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

  let metadataChanged = false;
  const pending = new Map<number, number>();
  const results = new Map<number, FeedResult[]>();
  for (const { feed } of activeOrigins)
    pending.set(feed.id, (pending.get(feed.id) ?? 0) + 1);
  for await (const result of fetchAndInsertFeedData({ db }, activeOrigins)) {
    metadataChanged ||= result.metadataChanged === true;
    const group = results.get(result.id) ?? [];
    group.push(result);
    results.set(result.id, group);
    if ("feedItems" in result && result.feedItems?.length) {
      stats.totalRowsWritten += result.feedItems.length;
      const affected = affectedFeedFromItems(result.id, result.feedItems);
      if (affected) stats.affectedFeeds.push(affected);
    }
    if (
      "feedItems" in result &&
      (result.feedItems?.length || result.removedItemIds?.length)
    ) {
      await publish({
        type: "feed-items",
        feedId: result.id,
        feedItems: result.feedItems ?? [],
        ...(result.removedItemIds?.length
          ? { removedItemIds: result.removedItemIds }
          : {}),
      });
    }
    if (result.status === "error")
      captureException(
        result.error instanceof Error
          ? result.error
          : new Error(String(result.error)),
        {
          feedId: result.id,
          originId: result.originId,
          feedName: feedNameMap.get(result.id) ?? "unknown",
        },
      );
    pending.set(result.id, pending.get(result.id)! - 1);
    if (pending.get(result.id)) continue;
    const status = group.some((entry) => entry.status === "error")
      ? "error"
      : group.some((entry) => entry.status === "success")
        ? "success"
        : group.some((entry) => entry.status === "empty")
          ? "empty"
          : "skipped";
    if (status === "error") {
      stats.errorCount++;
      stats.originFailureFeedIds.push(result.id);
    } else if (status === "success") stats.refreshedCount++;
    else if (status === "empty") stats.emptyCount++;
    else stats.skippedCount++;
    await publish({ type: "feed-status", status, feedId: result.id });
    results.delete(result.id);
  }

  if (metadataChanged && channel)
    await publisher.publish(channel, {
      source: "invalidation",
      chunk: {
        type: "reconciliation-invalidation",
        domains: ["organization", "navigation"],
        scopeImpact: { type: "known", selectors: [] },
      },
    });
  return stats;
}

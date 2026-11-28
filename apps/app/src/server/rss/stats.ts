import type { ApplicationFeedItem } from "~/server/db/schema";
import type {
  RssAffectedFeed,
  RssAttemptOutcome,
  RssAttemptSummary,
} from "~/lib/rss";
import { buildContentStatusKey } from "~/lib/content-status";

export type RefreshStats = Omit<RssAttemptSummary, "outcome">;

export function emptyRefreshStats(): RefreshStats {
  return {
    refreshedCount: 0,
    skippedCount: 0,
    emptyCount: 0,
    errorCount: 0,
    totalRowsWritten: 0,
    affectedFeeds: [],
    originFailureFeedIds: [],
  };
}

export function affectedFeedFromItems(
  feedId: number,
  items: ApplicationFeedItem[],
): RssAffectedFeed | null {
  if (items.length === 0) return null;
  return {
    feedId,
    contentStatusKeys: [
      ...new Set(
        items.map((item) =>
          buildContentStatusKey({
            saveStatus: item.isWatchLater ? "saved" : "inbox",
            archiveStatus: item.isWatched ? "archived" : "unread",
          }),
        ),
      ),
    ],
  };
}

export function addRefreshStats(target: RefreshStats, source: RefreshStats) {
  if (source.metadataChanged) target.metadataChanged = true;
  target.refreshedCount += source.refreshedCount;
  target.skippedCount += source.skippedCount;
  target.emptyCount += source.emptyCount;
  target.errorCount += source.errorCount;
  target.totalRowsWritten += source.totalRowsWritten;
  target.originFailureFeedIds = [
    ...new Set([
      ...target.originFailureFeedIds,
      ...source.originFailureFeedIds,
    ]),
  ];

  const affected = new Map(
    target.affectedFeeds.map((feed) => [feed.feedId, feed]),
  );
  for (const feed of source.affectedFeeds) {
    const current = affected.get(feed.feedId);
    affected.set(feed.feedId, {
      feedId: feed.feedId,
      contentStatusKeys: [
        ...new Set([
          ...(current?.contentStatusKeys ?? []),
          ...feed.contentStatusKeys,
        ]),
      ],
    });
  }
  target.affectedFeeds = [...affected.values()];
}

export function rssAttemptSummary(
  stats: RefreshStats,
  outcome: RssAttemptOutcome = stats.errorCount > 0 ? "partial" : "completed",
): RssAttemptSummary {
  return { ...stats, outcome };
}

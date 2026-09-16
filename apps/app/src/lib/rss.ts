import type { ContentStatusKey } from "./content-status";
import type { ApplicationFeedItem } from "~/server/db/schema";

export type RssTrigger = "automatic" | "manual";
export type RssFeedStatus = "success" | "empty" | "error" | "skipped";
export type RssAttemptOutcome = "completed" | "partial" | "failed";

export type RssAffectedFeed = {
  feedId: number;
  contentStatusKeys: ContentStatusKey[];
};

export type RssAttemptCounts = {
  refreshedCount: number;
  skippedCount: number;
  emptyCount: number;
  errorCount: number;
  totalRowsWritten: number;
};

export type RssAttemptSummary = RssAttemptCounts & {
  outcome: RssAttemptOutcome;
  affectedFeeds: RssAffectedFeed[];
  originFailureFeedIds: number[];
};

export type RssPublishedChunk =
  | {
      type: "refresh-start";
      totalFeeds: number;
      nextRefreshAt: Date;
    }
  | { type: "feed-status"; feedId: number; status: RssFeedStatus }
  | {
      type: "feed-items";
      feedId: number;
      feedItems: ApplicationFeedItem[];
      removedItemIds?: string[];
    }
  | ({ type: "rss-attempt-complete" } & RssAttemptSummary);

export type FetchDueSourcesResult =
  | { status: "background-managed" }
  | { status: "cooldown"; nextRefreshAt: Date }
  | ({
      status: "completed" | "partial";
      nextRefreshAt: Date;
    } & RssAttemptSummary);

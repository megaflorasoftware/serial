import type {
  ApplicationFeedOrigin,
  DatabaseFeedOrigin,
} from "~/server/db/schema";

type OriginLike = Pick<DatabaseFeedOrigin, "kind" | "locator">;

type FeedWithOrigins<TOrigin extends OriginLike> = { origins: TOrigin[] };

export function getRssOrigin<TOrigin extends OriginLike>(
  feed: FeedWithOrigins<TOrigin>,
): TOrigin | undefined {
  return feed.origins.find((origin) => origin.kind === "rss");
}

/**
 * The RSS feed URL a Feed subscribes to, or the empty string when the Feed
 * carries no RSS origin. Callers that treated `feed.url` as always present
 * keep the same empty-string fallback the old column defaulted to.
 */
export function getFeedRssUrl<TOrigin extends OriginLike>(
  feed: FeedWithOrigins<TOrigin>,
): string {
  return getRssOrigin(feed)?.locator ?? "";
}

/** Earliest next-fetch time across a Feed's origins, or null when none is scheduled. */
export function getFeedNextFetchAt(feed: {
  origins: Array<Pick<ApplicationFeedOrigin, "nextFetchAt">>;
}): Date | null {
  let earliest: Date | null = null;
  for (const origin of feed.origins) {
    if (!origin.nextFetchAt) continue;
    if (!earliest || origin.nextFetchAt < earliest)
      earliest = origin.nextFetchAt;
  }
  return earliest;
}

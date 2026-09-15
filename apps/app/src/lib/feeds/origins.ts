import type {
  ApplicationFeedOrigin,
  DatabaseFeedOrigin,
} from "~/server/db/schema";
import { FEED_ORIGIN_KIND } from "~/server/db/schema";

type OriginLike = Pick<DatabaseFeedOrigin, "kind" | "locator">;

type FeedWithOrigins<TOrigin extends OriginLike> = { origins: TOrigin[] };

export function getRssOrigin<TOrigin extends OriginLike>(
  feed: FeedWithOrigins<TOrigin>,
): TOrigin | undefined {
  return feed.origins.find((origin) => origin.kind === FEED_ORIGIN_KIND.RSS);
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
  return feed.origins.reduce<Date | null>(
    (earliest, origin) =>
      origin.nextFetchAt && (!earliest || origin.nextFetchAt < earliest)
        ? origin.nextFetchAt
        : earliest,
    null,
  );
}

/** The Feed in the list whose RSS origin is the given URL, if any. */
export function findFeedWithRssUrl<TFeed extends FeedWithOrigins<OriginLike>>(
  feeds: TFeed[],
  url: string,
): TFeed | undefined {
  return feeds.find((feed) => getFeedRssUrl(feed) === url);
}

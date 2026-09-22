import { httpUrl, matchesDiscoveredFeed } from "@serial/feed-discovery";
import type { DiscoveredFeed } from "@serial/feed-discovery";
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

/** Whether a discovery result shares an RSS or Atmosphere locator with an added Feed. */
export function isDiscoveredFeedAdded(
  feeds: Array<FeedWithOrigins<OriginLike>>,
  discovered: DiscoveredFeed,
): boolean {
  return feeds.some((feed) =>
    matchesDiscoveredFeed(discovered, {
      url: getFeedRssUrl(feed),
      origins: feed.origins.map(({ kind, locator }) => ({ kind, locator })),
    }),
  );
}

export function getAtmosphereOrigin<TOrigin extends OriginLike>(
  feed: FeedWithOrigins<TOrigin>,
): TOrigin | undefined {
  return feed.origins.find(
    (origin) => origin.kind === FEED_ORIGIN_KIND.ATPROTO,
  );
}

export function getFeedPublicationName(feed: {
  name: string;
  origins: Array<OriginLike & { sourceName: string | null }>;
}): string | undefined {
  const publication = getAtmosphereOrigin(feed);
  return publication ? publication.sourceName || feed.name : undefined;
}

/** Public website destination, preserving a publication's path when available. */
export function getFeedWebsiteUrl(feed: {
  platform: string;
  siteUrl: string | null;
  origins: OriginLike[];
}): string | undefined {
  const siteUrl = feed.siteUrl && httpUrl(feed.siteUrl);
  if (siteUrl) return siteUrl;
  const rssUrl = httpUrl(getFeedRssUrl(feed));
  if (!rssUrl) return undefined;
  const url = new URL(rssUrl);
  if (feed.platform === "youtube") {
    const channelId = url.searchParams.get("channel_id");
    if (channelId) return `https://www.youtube.com/channel/${channelId}`;
  }
  return url.origin;
}

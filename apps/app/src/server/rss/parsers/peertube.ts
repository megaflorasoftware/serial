import Parser from "rss-parser";
import { z } from "zod";
import {
  buildConditionalHeaders,
  parseHttpHeaders,
} from "../calculateNextFetch";
import {
  BASE_FEED_CUSTOM_FIELDS,
  baseFeedSchema,
  extractRssMetadata,
  newRssFeedDetails,
} from "../types";
import { readFeedHttp } from "../feedHttp";
import { boundFeedItems } from "../feedBounds";
import type {
  ConditionalHeaders,
  FeedFetchMetadata,
  FeedFetchResult,
  FetchableOrigin,
  NewFeedDetails,
  RSSContent,
} from "../types";
import { captureException, logError } from "~/server/logger";

const parser = new Parser({
  customFields: {
    feed: [...BASE_FEED_CUSTOM_FIELDS],
    item: ["media:group", "media:thumbnail", "media:description"],
  },
});

export const peerTubeItemSchema = z.object({
  creator: z.string(),
  title: z.string(),
  link: z.string(),
  pubDate: z.string(),
  "dc:creator": z.string(),
  guid: z.string(),
  "media:thumbnail": z.object({
    $: z.object({
      url: z.string(),
    }),
  }),
  "media:description": z.string().optional(),
  isoDate: z.string(),
});

export const peerTubeSchema = baseFeedSchema.extend({
  items: peerTubeItemSchema.array(),
  feedUrl: z.string(),
  image: z.object({
    link: z.string(),
    url: z.string(),
    title: z.string(),
  }),
  // paginationLinks:
  title: z.string(),
  description: z.string(),
  generator: z.string().includes("PeerTube -"),
  link: z.string(),
  copyright: z.string(),
  lastBuildDate: z.string(),
  docs: z.string(),
});

/**
 * Most feeds are not PeerTube, so a mismatch is the usual answer, not an
 * error. Neither is XML this stricter parser rejects: the website parser
 * reads feeds such as one with a bare ampersand in a title.
 */
export async function getPeerTubeFeedIfMatches(
  rssString: string,
): Promise<NewFeedDetails | null> {
  const rssData = await parser.parseString(rssString).catch(() => null);
  const peerTube = peerTubeSchema.safeParse(rssData);
  if (!peerTube.success) return null;
  return newRssFeedDetails({
    name: peerTube.data.title,
    url: peerTube.data.feedUrl,
    platform: "peertube",
    siteUrl: peerTube.data.link,
    description: peerTube.data.description,
  });
}

export async function fetchPeerTubeFeedData(
  { origin, feed }: FetchableOrigin,
  cached?: ConditionalHeaders,
): Promise<FeedFetchResult | null> {
  try {
    const feedResponse = await readFeedHttp(origin.locator, {
      headers: cached ? buildConditionalHeaders(cached) : undefined,
    });

    if (feedResponse.status === 304) {
      return {
        notModified: true,
        fetchMetadata: parseHttpHeaders(feedResponse),
      };
    }

    if (!feedResponse.ok) {
      throw new Error(
        `Failed to fetch PeerTube feed: ${feedResponse.status} ${feedResponse.statusText}`,
      );
    }
    const rssData = await parser.parseString(feedResponse.text);

    const data = peerTubeSchema.parse(rssData);

    // Build fetch metadata from HTTP headers and RSS elements
    const fetchMetadata: FeedFetchMetadata = {
      ...parseHttpHeaders(feedResponse),
      ...extractRssMetadata(data),
    };

    return {
      id: feed.id,
      title: data.title,
      url: data.link,
      items: boundFeedItems(
        data.items.flatMap((item) => {
          const idParts = item.guid.split("/");
          const id = idParts[idParts.length - 1];

          if (!id) return [];

          return [
            {
              id,
              title: item.title,
              publishedDate: item.isoDate,
              url: item.link,
              author: item.creator,
              thumbnail: item["media:thumbnail"].$.url,
              content: item["media:description"],
              contentSnippet: item["media:description"],
            } satisfies RSSContent,
          ];
        }),
      ),
      fetchMetadata,
    };
  } catch (e) {
    captureException(e, {
      context: "peertube-feed-fetch",
      feedId: feed.id,
      url: origin.locator,
    });
    logError("Error fetching PeerTube feed data for URL =", origin.locator);
    logError(e);
    return null;
  }
}

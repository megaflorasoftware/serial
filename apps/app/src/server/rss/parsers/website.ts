import {
  buildConditionalHeaders,
  parseHttpHeaders,
} from "../calculateNextFetch";
import { newRssFeedDetails } from "../types";
import { readFeedHttp } from "../feedHttp";
import { boundFeedItems } from "../feedBounds";
import { parseSyndicationFeed } from "../syndication";
import type {
  ConditionalHeaders,
  FeedFetchMetadata,
  FeedFetchResult,
  FetchableOrigin,
  NewFeedDetails,
} from "../types";
import { captureException, logError } from "~/server/logger";
import { workerPool } from "~/lib/workerPool";

const MAX_OG_IMAGE_FETCHES_PER_FEED = 8;
const OG_IMAGE_FETCH_CONCURRENCY = 2;

async function fetchOgImage(url: string): Promise<string | undefined> {
  try {
    const response = await readFeedHttp(url, {
      maxBodyBytes: 256 * 1024,
      totalDurationMs: 3_000,
    });

    if (!response.ok) return undefined;

    const html = response.text;

    // Try og:image meta tag
    const ogImageMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    );
    if (ogImageMatch?.[1]) {
      return ogImageMatch[1];
    }

    // Try alternate format (content before property)
    const ogImageAltMatch = html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    );
    if (ogImageAltMatch?.[1]) {
      return ogImageAltMatch[1];
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export async function getWebsiteFeedIfMatches(
  text: string,
  url: string,
): Promise<NewFeedDetails | null> {
  const data = parseSyndicationFeed(text, url);
  if (!data.title) return null;
  return newRssFeedDetails({
    url,
    platform: "website",
    name: data.title,
    imageUrl: data.imageUrl,
    siteUrl: data.siteUrl,
    description: data.description,
  });
}

export async function fetchWebsiteFeedData(
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
        `Failed to fetch website feed: ${feedResponse.status} ${feedResponse.statusText}`,
      );
    }
    const data = parseSyndicationFeed(feedResponse.text, origin.locator);
    const fetchMetadata: FeedFetchMetadata = {
      ...parseHttpHeaders(feedResponse),
      ...data.fetchMetadata,
    };
    const items = boundFeedItems(data.items);

    const metadataCandidates = items
      .flatMap((item, position) =>
        item.thumbnail ? [] : [{ itemIndex: position, item }],
      )
      .slice(0, MAX_OG_IMAGE_FETCHES_PER_FEED);

    for await (const { itemIndex, thumbnail } of workerPool(
      metadataCandidates,
      OG_IMAGE_FETCH_CONCURRENCY,
      async (candidate) => ({
        itemIndex: candidate.itemIndex,
        thumbnail: await fetchOgImage(candidate.item.url),
      }),
    )) {
      if (thumbnail && items[itemIndex]) {
        items[itemIndex].thumbnail = thumbnail;
      }
    }

    return {
      id: feed.id,
      title: data.title,
      imageUrl: data.imageUrl,
      description: data.description,
      url: data.siteUrl ?? new URL(origin.locator).origin,
      items,
      fetchMetadata,
    };
  } catch (e) {
    captureException(e, {
      context: "website-feed-fetch",
      feedId: feed.id,
      url: origin.locator,
    });
    logError("Error fetching website feed data for URL =", origin.locator);
    logError(e);
    return null;
  }
}

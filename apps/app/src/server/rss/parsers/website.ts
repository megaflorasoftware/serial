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

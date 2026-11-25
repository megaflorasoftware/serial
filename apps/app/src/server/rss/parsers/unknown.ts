import { readFeedHttp } from "../feedHttp";
import { FeedParseError } from "../syndication";
import { getPeerTubeFeedIfMatches } from "./peertube";
import { getWebsiteFeedIfMatches, logFeedParseFailure } from "./website";
import type { NewFeedDetails } from "../types";
import { captureException, logError } from "~/server/logger";

export async function fetchUnknownRssFeed(
  url: string,
  read: typeof readFeedHttp = readFeedHttp,
): Promise<NewFeedDetails | null> {
  try {
    const feed = await read(url);
    if (!feed.ok) {
      throw new Error(
        `Failed to fetch RSS feed: ${feed.status} ${feed.statusText}`,
      );
    }
    const text = feed.text;

    const peerTubeFeed = text.trimStart().startsWith("{")
      ? null
      : await getPeerTubeFeedIfMatches(text);
    if (peerTubeFeed) return peerTubeFeed;

    const websiteFeed = await getWebsiteFeedIfMatches(text, url);
    if (websiteFeed) return websiteFeed;

    return null;
  } catch (e) {
    if (e instanceof FeedParseError) {
      logFeedParseFailure(url, e);
      return null;
    }
    captureException(e, { context: "unknown-feed-fetch", url });
    logError(e);
    return null;
  }
}

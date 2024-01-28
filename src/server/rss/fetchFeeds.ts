import { type feeds } from "../db/schema";
import {
  fetchYouTubeFeedData,
  fetchYouTubeFeedDetails,
} from "./parsers/youtube";
import { type RSSFeed, type NewFeedDetails } from "./types";

export async function fetchNewFeedDetails(
  url: string,
): Promise<NewFeedDetails | null> {
  // process url
  if (url.includes("youtube.com/@")) {
    const feed = await fetch(url);
    const text = await feed.text();

    // extract channelId from text
    const channelId = text
      .match(/"channelId":([^&]{26})/)?.[1]
      ?.replaceAll('"', "");

    if (!!channelId) {
      url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    }
  }

  // get feeds
  if (url.includes("youtube.com")) {
    return fetchYouTubeFeedDetails(url);
  }
  return null;
}

export async function fetchFeedData(
  databaseFeeds: (typeof feeds.$inferSelect)[],
): Promise<RSSFeed[] | null> {
  return (
    await Promise.all(
      databaseFeeds.map(async (feed) => {
        if (feed.url.includes("youtube.com")) {
          return fetchYouTubeFeedData(feed);
        }
        return null;
      }),
    )
  ).filter(Boolean);
}

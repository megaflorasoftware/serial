import { type feeds } from "../db/schema";
import {
  fetchYouTubeFeedData,
  fetchYouTubeFeedDetails,
} from "./parsers/youtube";
import { type RSSFeed, type NewFeedDetails } from "./types";

export async function fetchNewFeedDetails(
  url: string,
): Promise<NewFeedDetails[]> {
  let urls = [url];

  // process url
  if (url.includes("youtube.com/@")) {
    const feed = await fetch(url);
    const text = await feed.text();

    // extract channelId from text
    const channelIds = text.matchAll(/"channelId":([^&]{26})/g);

    const idList = Array.from(channelIds)
      .map((id) => id?.[1]?.replaceAll('"', ""))
      .filter(Boolean);

    if (!!idList.length) {
      urls = idList.map(
        (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`,
      );
    }
  }

  const feedDetailList = (
    await Promise.all(
      urls.map(async (url) => {
        if (url.includes("youtube.com")) {
          return fetchYouTubeFeedDetails(url);
        }
        return null;
      }),
    )
  ).filter(Boolean);

  // get feeds
  return feedDetailList;
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

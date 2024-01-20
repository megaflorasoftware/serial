import { type feeds } from "../db/schema";
import {
  fetchYouTubeFeedData,
  fetchYouTubeFeedDetails,
} from "./parsers/youtube";
import { type RSSFeed, type NewFeedDetails } from "./types";

export async function fetchNewFeedDetails(
  url: string,
): Promise<NewFeedDetails | null> {
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

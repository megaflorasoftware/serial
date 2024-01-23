import { fetchYouTubeFeedDetails } from "../parsers/youtube";
import { type NewFeedDetails } from "../types";

export async function fetchNewFeedDetails(
  url: string,
): Promise<NewFeedDetails | null> {
  if (url.includes("youtube.com")) {
    return fetchYouTubeFeedDetails(url);
  }
  return null;
}

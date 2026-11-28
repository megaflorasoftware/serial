import { digestOf, rssItemDigest } from "./itemObservation";
import type { RSSContent } from "./types";
import type { ContentType } from "~/lib/content/descriptor";
import { CONTENT_TYPE } from "~/lib/content/descriptor";

/**
 * Bump to store every video item again on its next fetch, after a change to
 * what `insertFeedItems` stores for the same parsed item that stored items
 * should follow: its normalized URL, orientation or hash.
 */
const VIDEO_DERIVATION = 1;

/**
 * Identifies a video item by the parsed item it is stored from. Covers exactly
 * what `insertFeedItems` reads.
 */
function videoItemDigest(item: RSSContent) {
  return digestOf({
    derivation: VIDEO_DERIVATION,
    id: item.id,
    url: item.url,
    title: item.title,
    author: item.author,
    content: item.content,
    contentSnippet: item.contentSnippet,
    thumbnail: item.thumbnail,
    publishedDate: item.publishedDate,
  });
}

/**
 * Identifies a parsed feed by what its ingest reads of it: the medium that
 * decides which ingest a Feed takes, and each item in the order the feed
 * states them. It reads no stored row, so a feed that parses to the digest
 * stored when it was last ingested in full has nothing to read or write.
 */
export function parsedFeedDigest(medium: ContentType, items: RSSContent[]) {
  const itemDigest =
    medium === CONTENT_TYPE.TEXT ? rssItemDigest : videoItemDigest;
  return digestOf({ medium, items: items.map(itemDigest) });
}

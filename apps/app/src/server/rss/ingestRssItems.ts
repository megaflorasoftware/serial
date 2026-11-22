import { readStoredStates } from "./itemIdentity";
import { itemUrl, rssItemDigest, rssObservation } from "./itemObservation";
import { legacyItemHash } from "./legacyItemHash";
import {
  enrichObservationImages,
  needsPageImage,
  PAGE_IMAGE_BATCH_SIZE,
} from "./observationImages";
import { writeIncomingObservations } from "./writeItems";
import type { readFeedHttp } from "./feedHttp";
import type { StoredItemState } from "./itemIdentity";
import type { RSSContent } from "./types";
import type { db } from "../db";
import type { DatabaseFeed } from "../db/schema";

/** A parsed item with what finds and identifies it, before its body is read. */
type StatedItem = { item: RSSContent; url: string; digest: string };

function statedItem(item: RSSContent): StatedItem[] {
  try {
    return [{ item, url: itemUrl(item.url), digest: rssItemDigest(item) }];
  } catch {
    // An item whose URL cannot be normalized is not ingested.
    return [];
  }
}

/** An item whose body cannot be read is not ingested either. */
function observationOf(item: RSSContent) {
  try {
    return rssObservation(item);
  } catch {
    return undefined;
  }
}

/** A feed that repeats a URL means its last entry, as writing them in order would. */
function lastPerUrl(stated: StatedItem[]) {
  return [...new Map(stated.map((entry) => [entry.url, entry])).values()];
}

/** The feed states what is already stored: no body is compared, only hashes. */
function isSettled(
  { item, digest }: StatedItem,
  stored: StoredItemState | undefined,
) {
  if (!stored) return false;
  // Where only another origin observed the item, this is the feed's first word on it.
  if (stored.observed) return stored.rssDigest === digest;
  // Stored before observations existed: left alone until its publisher edits it.
  return (
    stored.contentHash !== null &&
    stored.contentHash === legacyItemHash(item, stored.thumbnail)
  );
}

/**
 * Brings a parsed feed's items into storage. Only the items the feed states
 * differently are sanitized, read in full, looked up and written. An unchanged
 * feed costs the narrow read of what is stored.
 */
export async function ingestRssItems(
  database: typeof db,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  items: RSSContent[],
  readPage?: typeof readFeedHttp,
) {
  const stated = lastPerUrl(items.flatMap(statedItem));
  if (!stated.length) return { items: [], removedItemIds: [] as string[] };
  const stored = await readStoredStates(
    database,
    feed.id,
    stated.map((entry) => entry.url),
  );
  const changed = stated.flatMap((entry) => {
    if (isSettled(entry, stored.get(entry.url))) return [];
    const observation = observationOf(entry.item);
    return observation ? [{ digest: entry.digest, observation }] : [];
  });
  // One bounded batch of page lookups per fetch, for changed items alone.
  const lookedUp = new Map(
    (
      await enrichObservationImages(
        changed
          .map((entry) => entry.observation)
          .filter(needsPageImage)
          .slice(0, PAGE_IMAGE_BATCH_SIZE),
        readPage,
      )
    ).map((observation) => [observation.url, observation]),
  );
  return writeIncomingObservations(
    database,
    feed,
    changed.map(({ observation, digest }) => {
      const enriched = lookedUp.get(observation.url);
      return enriched
        ? { observation: enriched, digest }
        : {
            observation,
            digest,
            // Past the batch no lookup ran, so the page image it had stands.
            keepStoredPageImage: needsPageImage(observation),
          };
    }),
  );
}

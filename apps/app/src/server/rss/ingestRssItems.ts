import { itemLocators, readItemIdentity } from "./itemIdentity";
import { itemUrl, rssItemDigest, rssObservation } from "./itemObservation";
import { legacyItemHash } from "./legacyItemHash";
import {
  enrichObservationImages,
  needsPageImage,
  PAGE_IMAGE_BATCH_SIZE,
} from "./observationImages";
import { writeIncomingObservations } from "./writeItems";
import type { readFeedHttp } from "./feedHttp";
import type { ItemIdentity } from "./itemIdentity";
import type { RSSContent } from "./types";
import type { db } from "../db";
import type { DatabaseFeed } from "../db/schema";

/** A parsed item with what finds and identifies it, before its body is read. */
type StatedItem = { item: RSSContent; url: string; digest: string };

/**
 * - `settled`: stored as the feed states it, nothing to do.
 * - `awaitingImage`: stored as the feed states it, but its page image lookup has not run.
 * - `changed`: new, or the feed states something else now.
 */
type ItemState = "settled" | "awaitingImage" | "changed";

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

/** Reads one stated item against the narrow identity: no body is compared, only hashes. */
function itemStates(identity: ItemIdentity) {
  const locators = itemLocators(identity);
  const items = new Map(identity.items.map((item) => [item.id, item]));
  const observed = new Set(identity.observations.map((entry) => entry.itemId));
  const rss = new Map(
    identity.observations
      .filter((entry) => entry.kind === "rss")
      .map((entry) => [entry.itemId, entry]),
  );
  return ({ item, url, digest }: StatedItem): ItemState => {
    const stored = items.get(locators.get(url) ?? "");
    if (!stored) return "changed";
    const previous = rss.get(stored.id);
    if (previous)
      return previous.digest !== digest
        ? "changed"
        : previous.imagePending
          ? "awaitingImage"
          : "settled";
    // Another origin observed it, and this is the feed's first word on it.
    if (observed.has(stored.id)) return "changed";
    // Stored before observations existed: left alone until its publisher edits it.
    return stored.contentHash !== null &&
      stored.contentHash === legacyItemHash(item, stored.thumbnail)
      ? "settled"
      : "changed";
  };
}

/**
 * Brings a parsed feed's items into storage. Only items the feed states
 * differently, or whose page image is still owed, are sanitized, read in full,
 * looked up and written. An unchanged feed costs the narrow identity read.
 */
export async function ingestRssItems(
  database: typeof db,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  items: RSSContent[],
  readPage?: typeof readFeedHttp,
) {
  const stated = lastPerUrl(items.flatMap(statedItem));
  if (!stated.length) return { items: [], removedItemIds: [] as string[] };
  const stateOf = itemStates(
    await readItemIdentity(
      database,
      feed.id,
      stated.map(({ item, url }) => ({ kind: "rss", url, key: item.id })),
    ),
  );
  const open = stated.flatMap((entry) => {
    const state = stateOf(entry);
    // Only an item that is not settled has its body sanitized.
    const observation =
      state === "settled" ? undefined : observationOf(entry.item);
    return observation ? [{ state, digest: entry.digest, observation }] : [];
  });
  // One bounded batch of page lookups per fetch; the rest wait for the next.
  const lookedUp = new Map(
    (
      await enrichObservationImages(
        open
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
    open.flatMap(({ observation, digest, state }) => {
      const enriched = lookedUp.get(observation.url);
      if (enriched) return [{ observation: enriched, digest }];
      // Nothing to write for an item that only waits for its lookup.
      if (state === "awaitingImage") return [];
      return [
        { observation, digest, imagePending: needsPageImage(observation) },
      ];
    }),
  );
}

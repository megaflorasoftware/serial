import { and, eq, inArray } from "drizzle-orm";
import { feedItemAliases, feedItemObservations, feedItems } from "../db/schema";
import type { FeedDatabase } from "../feeds/origins";
import type {
  DatabaseFeedItem,
  DatabaseFeedItemAlias,
  DatabaseFeedItemObservation,
} from "../db/schema";
import type { ItemObservation } from "./itemObservation";

type ItemReader = Pick<FeedDatabase, "select">;
/** What finds an observation's item: its URL, and for a document its identity. */
export type ObservationLocator = Pick<ItemObservation, "kind" | "url" | "key">;

/**
 * What a write decides on and what it carries over from a stored item, without
 * its body: where the item is found, the hash of what it shows, and the reader
 * state a merge may move.
 */
const identityColumns = {
  id: feedItems.id,
  url: feedItems.url,
  normalizedUrl: feedItems.normalizedUrl,
  atprotoUri: feedItems.atprotoUri,
  contentHash: feedItems.contentHash,
  thumbnail: feedItems.thumbnail,
  isWatched: feedItems.isWatched,
  isWatchLater: feedItems.isWatchLater,
  isWatchedUpdatedAt: feedItems.isWatchedUpdatedAt,
  isWatchLaterUpdatedAt: feedItems.isWatchLaterUpdatedAt,
  progress: feedItems.progress,
};

export type IdentityItem = Pick<DatabaseFeedItem, keyof typeof identityColumns>;
export type IdentityObservation = Pick<
  DatabaseFeedItemObservation,
  "itemId" | "kind" | "digest" | "imagePending"
>;
export type IdentityAlias = Pick<DatabaseFeedItemAlias, "locator" | "itemId">;

/** The stored state an incoming batch can touch, narrow enough to read on every fetch. */
export type ItemIdentity = {
  items: IdentityItem[];
  observations: IdentityObservation[];
  aliases: IdentityAlias[];
};

/** The same state with the bodies a write composes from. */
export type MatchedItems = {
  items: DatabaseFeedItem[];
  observations: DatabaseFeedItemObservation[];
  aliases: DatabaseFeedItemAlias[];
};

/**
 * The Feed's items an incoming batch may refer to: by current or normalized
 * URL, by a URL the item was once known under, or by document identity.
 * Separate indexed branches avoid scanning the Feed for an OR predicate.
 */
function matchedItemIds(
  database: ItemReader,
  feedId: number,
  incoming: ObservationLocator[],
) {
  const locators = [
    ...new Set(
      incoming.flatMap((item) =>
        item.kind === "atproto"
          ? [item.url, `atproto:${item.key}`]
          : [item.url],
      ),
    ),
  ];
  const documentUris = incoming
    .filter((item) => item.kind === "atproto")
    .map((item) => item.key);
  const itemsWhere = (condition: ReturnType<typeof inArray>) =>
    database
      .select({ id: feedItems.id })
      .from(feedItems)
      .where(and(eq(feedItems.feedId, feedId), condition));
  const matched = itemsWhere(inArray(feedItems.url, locators))
    .union(itemsWhere(inArray(feedItems.normalizedUrl, locators)))
    .union(
      database
        .select({ id: feedItemAliases.itemId })
        .from(feedItemAliases)
        .where(
          and(
            eq(feedItemAliases.feedId, feedId),
            inArray(feedItemAliases.locator, locators),
          ),
        ),
    );
  return documentUris.length
    ? matched.union(itemsWhere(inArray(feedItems.atprotoUri, documentUris)))
    : matched;
}

/** Two statements, no item body and no observation value. */
export async function readItemIdentity(
  database: ItemReader,
  feedId: number,
  incoming: ObservationLocator[],
): Promise<ItemIdentity> {
  const rows = await database
    .select({
      ...identityColumns,
      kind: feedItemObservations.kind,
      digest: feedItemObservations.digest,
      imagePending: feedItemObservations.imagePending,
    })
    .from(feedItems)
    .leftJoin(
      feedItemObservations,
      eq(feedItemObservations.itemId, feedItems.id),
    )
    .where(inArray(feedItems.id, matchedItemIds(database, feedId, incoming)));
  const aliases = await database
    .select({
      locator: feedItemAliases.locator,
      itemId: feedItemAliases.itemId,
    })
    .from(feedItemAliases)
    // By item alone: the matched ids already belong to the Feed, and naming
    // the Feed here would walk every alias it has.
    .where(
      inArray(
        feedItemAliases.itemId,
        matchedItemIds(database, feedId, incoming),
      ),
    );
  const items = new Map<string, IdentityItem>();
  const observations: IdentityObservation[] = [];
  for (const { kind, digest, imagePending, ...item } of rows) {
    items.set(item.id, item);
    if (kind !== null)
      observations.push({
        itemId: item.id,
        kind,
        digest,
        imagePending: Boolean(imagePending),
      });
  }
  return { items: [...items.values()], observations, aliases };
}

/** The matched items in full, for the few a write is about to change. */
export async function loadMatchedItems(
  database: ItemReader,
  feedId: number,
  incoming: ObservationLocator[],
): Promise<MatchedItems> {
  const items = await database
    .select()
    .from(feedItems)
    .where(inArray(feedItems.id, matchedItemIds(database, feedId, incoming)));
  if (!items.length) return { items, observations: [], aliases: [] };
  const ids = items.map((item) => item.id);
  const observations = await database
    .select()
    .from(feedItemObservations)
    .where(inArray(feedItemObservations.itemId, ids));
  // Every alias of a matched item, not only the incoming locators: a write
  // then knows which aliases already stand and repeats none of them.
  const aliases = await database
    .select()
    .from(feedItemAliases)
    .where(inArray(feedItemAliases.itemId, ids));
  return { items, observations, aliases };
}

/** Where each known locator points: aliases first, then each item's current locators. */
export function itemLocators(
  identity: Pick<ItemIdentity, "aliases"> & {
    items: Array<
      Pick<IdentityItem, "id" | "url" | "normalizedUrl" | "atprotoUri">
    >;
  },
) {
  const lookup = new Map(
    identity.aliases.map((alias) => [alias.locator, alias.itemId]),
  );
  for (const item of identity.items) {
    lookup.set(item.url, item.id);
    if (item.normalizedUrl) lookup.set(item.normalizedUrl, item.id);
    if (item.atprotoUri) lookup.set(`atproto:${item.atprotoUri}`, item.id);
  }
  return lookup;
}

function byText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One comparable text for an identity, whatever order its rows came in. */
function identityText({ items, observations, aliases }: ItemIdentity) {
  return JSON.stringify([
    items
      .map((item) => [
        item.id,
        item.url,
        item.normalizedUrl,
        item.atprotoUri,
        item.contentHash,
        item.isWatched,
        item.isWatchLater,
        item.isWatchedUpdatedAt?.getTime() ?? null,
        item.isWatchLaterUpdatedAt?.getTime() ?? null,
        item.progress,
      ])
      .sort((a, b) => byText(String(a[0]), String(b[0]))),
    observations
      .map((entry) => [
        `${entry.itemId}:${entry.kind}`,
        entry.digest,
        Boolean(entry.imagePending),
      ])
      .sort((a, b) => byText(String(a[0]), String(b[0]))),
    aliases
      .map((alias) => [alias.locator, alias.itemId])
      .sort((a, b) => byText(a[0]!, b[0]!)),
  ]);
}

/** Nothing a write decided on or carries over has changed between two reads. */
export function sameIdentity(a: ItemIdentity, b: ItemIdentity) {
  return identityText(a) === identityText(b);
}

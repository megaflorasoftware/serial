import { and, eq, inArray, sql } from "drizzle-orm";
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
 * How firmly an item holds a locator. Its current URL outranks its normalized
 * URL, which outranks a URL it was once known under.
 */
const CLAIM = { alias: 0, normalizedUrl: 1, current: 2 } as const;
type LocatorClaim = { locator: string; itemId: string; strength: number };

/** Where each claimed locator points: to its strongest claim, and among equals the last. */
function resolveLocators(claims: LocatorClaim[]) {
  const held = new Map<string, LocatorClaim>();
  for (const claim of claims) {
    const holder = held.get(claim.locator);
    if (!holder || claim.strength >= holder.strength)
      held.set(claim.locator, claim);
  }
  return new Map(
    [...held].map(([locator, claim]) => [locator, claim.itemId] as const),
  );
}

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
  isWatched: feedItems.isWatched,
  isWatchLater: feedItems.isWatchLater,
  isWatchedUpdatedAt: feedItems.isWatchedUpdatedAt,
  isWatchLaterUpdatedAt: feedItems.isWatchLaterUpdatedAt,
  progress: feedItems.progress,
};

export type IdentityItem = Pick<DatabaseFeedItem, keyof typeof identityColumns>;
export type IdentityObservation = Pick<
  DatabaseFeedItemObservation,
  "itemId" | "kind" | "digest"
>;
export type IdentityAlias = Pick<DatabaseFeedItemAlias, "locator" | "itemId">;

/** The stored state a write decided on, without bodies: what its transaction rereads. */
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

/**
 * What tells whether a feed still states what is stored under a URL. An item
 * some origin observed is judged by the digest of what the feed last stated,
 * which is absent when only another origin observed it. An item from before
 * observations existed is judged by the hash and thumbnail the previous ingest
 * left on it.
 */
export type StoredItemState =
  | { itemId: string; observed: true; rssDigest?: string | null }
  | {
      itemId: string;
      observed: false;
      contentHash: string | null;
      thumbnail: string;
    };

/** Every claim the Feed's items make on the stated URLs, one row per item and URL. */
function locatorClaims(database: ItemReader, feedId: number, urls: string[]) {
  const strength = (claim: number) =>
    sql<number>`${sql.raw(String(claim))}`.as("strength");
  // Each branch reads its locator from the index that finds it. Only an
  // item's id comes from its row, and that sits ahead of the body.
  const itemClaims = (
    locator: typeof feedItems.url | typeof feedItems.normalizedUrl,
    claim: number,
  ) =>
    database
      .select({
        itemId: feedItems.id,
        locator: sql<string>`${locator}`,
        strength: strength(claim),
      })
      .from(feedItems)
      .where(and(eq(feedItems.feedId, feedId), inArray(locator, urls)));
  const claims = database
    .select({
      itemId: feedItemAliases.itemId,
      locator: feedItemAliases.locator,
      strength: strength(CLAIM.alias),
    })
    .from(feedItemAliases)
    .where(
      and(
        eq(feedItemAliases.feedId, feedId),
        inArray(feedItemAliases.locator, urls),
      ),
    )
    .unionAll(itemClaims(feedItems.normalizedUrl, CLAIM.normalizedUrl))
    .unionAll(itemClaims(feedItems.url, CLAIM.current))
    .as("claims");
  // An item usually holds its URL both as its current one and as an alias.
  return database
    .select({
      itemId: claims.itemId,
      locator: claims.locator,
      strength: sql<number>`max(${claims.strength})`,
    })
    .from(claims)
    .groupBy(claims.itemId, claims.locator);
}

/**
 * Each located item's state. An item's row gives up only what sits ahead of
 * its body. The hash the previous ingest left sits behind the body, where
 * SQLite reaches it by walking the body's overflow pages, so it is read only
 * for an item no origin has observed.
 */
async function storedItemStates(database: ItemReader, itemIds: string[]) {
  const rows = await database
    .select({
      id: feedItems.id,
      thumbnail: feedItems.thumbnail,
      kind: feedItemObservations.kind,
      digest: feedItemObservations.digest,
      unobservedHash: sql<
        string | null
      >`case when ${feedItemObservations.itemId} is null then ${feedItems.contentHash} end`,
    })
    .from(feedItems)
    .leftJoin(
      feedItemObservations,
      eq(feedItemObservations.itemId, feedItems.id),
    )
    .where(inArray(feedItems.id, itemIds));
  const states = new Map<string, StoredItemState>();
  // One row per observation, or a single row without a kind for an unobserved item.
  for (const { id, thumbnail, kind, digest, unobservedHash } of rows) {
    if (kind === null)
      states.set(id, {
        itemId: id,
        observed: false,
        contentHash: unobservedHash,
        thumbnail,
      });
    else
      states.set(id, {
        ...states.get(id),
        itemId: id,
        observed: true,
        ...(kind === "rss" ? { rssDigest: digest } : {}),
      });
  }
  return states;
}

/**
 * The narrow read that settles an unchanged feed, in two statements: where
 * each stated URL points, then the state of the items found. Neither reads an
 * item's body or an observation's value.
 */
export async function readStoredStates(
  database: ItemReader,
  feedId: number,
  urls: string[],
) {
  const located = resolveLocators(await locatorClaims(database, feedId, urls));
  if (!located.size) return new Map<string, StoredItemState>();
  const states = await storedItemStates(database, [
    ...new Set(located.values()),
  ]);
  return new Map(
    [...located].flatMap(([locator, itemId]) => {
      const state = states.get(itemId);
      return state ? [[locator, state] as const] : [];
    }),
  );
}

/**
 * The matched items without their bodies, as a write's transaction rereads
 * them to verify what it decided on. It reads reader state from behind the
 * body, which only a write pays for.
 */
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
    })
    .from(feedItems)
    .leftJoin(
      feedItemObservations,
      eq(feedItemObservations.itemId, feedItems.id),
    )
    .where(inArray(feedItems.id, matchedItemIds(database, feedId, incoming)));
  const items = new Map<string, IdentityItem>();
  const observations: IdentityObservation[] = [];
  for (const { kind, digest, ...item } of rows) {
    items.set(item.id, item);
    if (kind !== null) observations.push({ itemId: item.id, kind, digest });
  }
  if (!rows.length) return { items: [], observations, aliases: [] };
  // By item alone: the ids just read already belong to the Feed, and naming
  // the Feed here would walk every alias it has.
  const aliases = await database
    .select({
      locator: feedItemAliases.locator,
      itemId: feedItemAliases.itemId,
    })
    .from(feedItemAliases)
    .where(
      inArray(feedItemAliases.itemId, [...new Set(rows.map((row) => row.id))]),
    );
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
  // then knows which aliases already stand and repeats none of them. This
  // also runs on a transaction handle, whose statements go one at a time.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const aliases = await database
    .select()
    .from(feedItemAliases)
    .where(inArray(feedItemAliases.itemId, ids));
  return { items, observations, aliases };
}

/** Where each known locator points, from the items and aliases a write loaded. */
export function itemLocators(identity: {
  aliases: IdentityAlias[];
  items: Array<
    Pick<IdentityItem, "id" | "url" | "normalizedUrl" | "atprotoUri">
  >;
}) {
  return resolveLocators([
    ...identity.aliases.map((alias) => ({
      ...alias,
      strength: CLAIM.alias,
    })),
    ...identity.items.flatMap((item) => [
      ...(item.normalizedUrl
        ? [
            {
              locator: item.normalizedUrl,
              itemId: item.id,
              strength: CLAIM.normalizedUrl,
            },
          ]
        : []),
      { locator: item.url, itemId: item.id, strength: CLAIM.current },
      ...(item.atprotoUri
        ? [
            {
              locator: `atproto:${item.atprotoUri}`,
              itemId: item.id,
              strength: CLAIM.current,
            },
          ]
        : []),
    ]),
  ]);
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
      .map((entry) => [`${entry.itemId}:${entry.kind}`, entry.digest])
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

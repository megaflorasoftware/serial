import { createId } from "@paralleldrive/cuid2";
import { inArray, sql } from "drizzle-orm";
import { runDatabaseWrite } from "../db/retry-write";
import { feedItemAliases, feedItemObservations, feedItems } from "../db/schema";
import { buildConflictUpdateColumns } from "../db/utils";
import { toApplicationFeedItem } from "../feeds/reader-bodies";
import {
  composeItem,
  legacyObservation,
  observationDigest,
} from "./itemObservation";
import { computeItemHash } from "./hash";
import {
  itemLocators,
  loadMatchedItems,
  readItemIdentity,
  sameIdentity,
} from "./itemIdentity";
import { resolveItemDate } from "./publishedDate";
import type { FeedDatabase } from "../feeds/origins";
import type { MatchedItems } from "./itemIdentity";
import type { ItemObservation } from "./itemObservation";
import type { db } from "../db";
import type { DatabaseFeed, DatabaseFeedItem } from "../db/schema";
import { dbSemaphore } from "~/lib/semaphore";

/** An observation on its way in, with what is known of its page image lookup. */
export type IncomingObservation = {
  observation: ItemObservation;
  /** Identifies what its source stated; stored so the next fetch can tell without the value. */
  digest: string;
  /** The lookup has not run yet. A page image stored for the same URL stands until it does. */
  imagePending?: boolean;
};

type StoredObservation = {
  value: ItemObservation;
  digest: string | null;
  imagePending: boolean;
};
type Sources = Partial<Record<ItemObservation["kind"], StoredObservation>>;

type ItemWrites = {
  /** Items another item absorbed, stored or not; readers drop them. */
  removedItemIds: string[];
  /** The absorbed items that exist in storage. */
  deletedItemIds: string[];
  items: Array<typeof feedItems.$inferInsert>;
  observations: Array<typeof feedItemObservations.$inferInsert>;
  aliases: Array<typeof feedItemAliases.$inferInsert>;
};

type CommitGuards = {
  canWrite: (transaction: FeedDatabase) => Promise<boolean>;
  didWrite: (transaction: FeedDatabase) => Promise<void>;
};

const NOTHING_WRITTEN = { items: [], removedItemIds: [] as string[] };
/** Reads repeated this many times against concurrent writers before one transaction reads and writes. */
const OPTIMISTIC_ATTEMPTS = 2;

function combineUserState(keep: DatabaseFeedItem, other: DatabaseFeedItem) {
  for (const [field, timestamp] of [
    ["isWatched", "isWatchedUpdatedAt"],
    ["isWatchLater", "isWatchLaterUpdatedAt"],
  ] as const) {
    if (
      (other[timestamp]?.getTime() ?? 0) > (keep[timestamp]?.getTime() ?? 0)
    ) {
      keep[field] = other[field];
      keep[timestamp] = other[timestamp];
    }
  }
  keep.progress = Math.max(keep.progress, other.progress);
  keep.createdAt = new Date(
    Math.min(keep.createdAt.getTime(), other.createdAt.getTime()),
  );
}

/** Each stored item's observations; an item from before observations existed speaks for itself. */
function storedSources({ items, observations }: MatchedItems) {
  const sources = new Map<string, Sources>();
  for (const { itemId, kind, value, digest, imagePending } of observations)
    sources.set(itemId, {
      ...sources.get(itemId),
      [kind]: { value, digest, imagePending },
    });
  for (const item of items)
    if (!sources.has(item.id))
      sources.set(item.id, {
        rss: {
          value: legacyObservation(item),
          digest: null,
          imagePending: false,
        },
      });
  return sources;
}

/** An undated RSS item keeps its first-seen time across refreshes and edits. */
function datedObservation(
  observation: ItemObservation,
  stored: Sources,
  row: DatabaseFeedItem | undefined,
  now: Date,
): ItemObservation {
  if (
    observation.kind !== "rss" ||
    Number.isFinite(new Date(observation.publishedAt).getTime())
  )
    return observation;
  return {
    ...observation,
    publishedAt: resolveItemDate(
      new Date(observation.publishedAt),
      stored.rss?.value.publishedAt
        ? new Date(stored.rss.value.publishedAt)
        : row?.postedAt,
      now,
    ).toISOString(),
  };
}

/** Until its own lookup runs, an observation keeps the page image stored for the same URL. */
function withStandingPageImage(
  { observation, imagePending }: IncomingObservation,
  stored: StoredObservation | undefined,
): ItemObservation {
  return imagePending &&
    stored?.value.url === observation.url &&
    stored.value.pageImageUrl !== undefined
    ? { ...observation, pageImageUrl: stored.value.pageImageUrl }
    : observation;
}

function sameStoredObservation(
  previous: MatchedItems["observations"][number] | undefined,
  next: StoredObservation,
) {
  return (
    previous !== undefined &&
    previous.digest === next.digest &&
    previous.imagePending === next.imagePending &&
    JSON.stringify(previous.value) === JSON.stringify(next.value)
  );
}

/**
 * Everything one batch changes, worked out from the matched items alone:
 * identity, the visible composite, each origin's observation, and aliases.
 */
function planItemWrites(
  feedId: number,
  matched: MatchedItems,
  incoming: IncomingObservation[],
  now: Date,
): ItemWrites {
  const persisted = new Set(matched.items.map((item) => item.id));
  const rows = new Map(matched.items.map((item) => [item.id, { ...item }]));
  const sources = storedSources(matched);
  const lookup = itemLocators(matched);
  const changed = new Map<string, typeof feedItems.$inferInsert>();
  const touched = new Set<string>();
  const removedItemIds: string[] = [];
  for (const entry of incoming) {
    const { observation } = entry;
    // RSS GUIDs may be reused across distinct URLs. Only documents
    // have a stable identity that can establish a URL change.
    const byKey =
      observation.kind === "atproto"
        ? lookup.get(`atproto:${observation.key}`)
        : undefined;
    const byUrl = lookup.get(observation.url);
    // The stable document identity survives a collision with an RSS-only row.
    const id = byKey ?? byUrl ?? createId();
    const row = rows.get(id);
    const values = sources.get(id) ?? {};
    const otherId =
      byKey && byUrl && byKey !== byUrl
        ? id === byKey
          ? byUrl
          : byKey
        : undefined;
    if (otherId) {
      const other = rows.get(otherId);
      if (row && other) combineUserState(row, other);
      Object.assign(values, { ...sources.get(otherId), ...values });
      // The absorbed item's locators, historical ones included, follow it.
      for (const [locator, target] of lookup)
        if (target === otherId) lookup.set(locator, id);
      removedItemIds.push(otherId);
      changed.delete(otherId);
      touched.delete(otherId);
      rows.delete(otherId);
      sources.delete(otherId);
    }
    values[observation.kind] = {
      value: datedObservation(
        withStandingPageImage(entry, values[observation.kind]),
        values,
        row,
        now,
      ),
      digest: entry.digest,
      imagePending: Boolean(entry.imagePending),
    };
    sources.set(id, values);
    touched.add(id);
    const composed = composeItem(values.rss?.value, values.atproto?.value);
    const value = {
      ...row,
      ...composed,
      id,
      feedId,
      normalizedUrl: null,
      contentType: "text" as const,
      orientation: null,
      createdAt: row?.createdAt ?? now,
      updatedAt: now,
      contentHash: computeItemHash({
        ...composed,
        content: JSON.stringify(composed),
      }),
    };
    if (!row || row.contentHash !== value.contentHash || otherId)
      changed.set(id, value);
    lookup.set(observation.url, id);
    if (observation.kind === "atproto")
      lookup.set(`atproto:${observation.key}`, id);
    rows.set(id, {
      isWatched: false,
      isWatchLater: false,
      progress: 0,
      duration: 0,
      isWatchedUpdatedAt: null,
      isWatchLaterUpdatedAt: null,
      ...value,
    });
  }
  const previousObservations = new Map(
    matched.observations.map((entry) => [
      `${entry.itemId}:${entry.kind}`,
      entry,
    ]),
  );
  const previousAliases = new Map(
    matched.aliases.map((alias) => [alias.locator, alias.itemId]),
  );
  return {
    removedItemIds,
    deletedItemIds: removedItemIds.filter((id) => persisted.has(id)),
    items: [...changed.values()],
    observations: [...touched].flatMap((itemId) =>
      Object.values(sources.get(itemId)!)
        .filter(
          (stored) =>
            !sameStoredObservation(
              previousObservations.get(`${itemId}:${stored.value.kind}`),
              stored,
            ),
        )
        .map((stored) => ({ itemId, kind: stored.value.kind, ...stored })),
    ),
    aliases: [...lookup]
      .filter(
        ([locator, id]) =>
          touched.has(id) && previousAliases.get(locator) !== id,
      )
      .map(([locator, itemId]) => ({ feedId, locator, itemId })),
  };
}

function writesNothing(writes: ItemWrites) {
  return !(
    writes.deletedItemIds.length ||
    writes.items.length ||
    writes.observations.length ||
    writes.aliases.length
  );
}

function slices<T>(rows: T[], size: number) {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) =>
    rows.slice(index * size, (index + 1) * size),
  );
}

/** Statement order matters: absorbed rows free their URL, items precede what references them. */
async function applyItemWrites(tx: FeedDatabase, writes: ItemWrites) {
  // Deleting an absorbed item cascades its observations and aliases, which
  // the survivor's writes below restate.
  if (writes.deletedItemIds.length)
    await tx
      .delete(feedItems)
      .where(inArray(feedItems.id, writes.deletedItemIds));
  const written: DatabaseFeedItem[] = [];
  // Keep each statement below SQLite's host-parameter limit.
  for (const batch of slices(writes.items, 25))
    // Keep statement order inside the single writer transaction.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    written.push(
      ...(await tx
        .insert(feedItems)
        .values(batch)
        .onConflictDoUpdate({
          target: feedItems.id,
          set: buildConflictUpdateColumns(feedItems, [
            "contentId",
            "url",
            "normalizedUrl",
            "title",
            "author",
            "content",
            "sourceCid",
            "contentSnippet",
            "thumbnail",
            "postedAt",
            "sourceKind",
            "bodySource",
            "atprotoUri",
            "tags",
            "contentHash",
            "updatedAt",
            "isWatched",
            "isWatchLater",
            "isWatchedUpdatedAt",
            "isWatchLaterUpdatedAt",
            "progress",
            "createdAt",
          ]),
        })
        .returning()),
    );
  for (const batch of slices(writes.observations, 100))
    // Bound each statement and preserve transaction order.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await tx
      .insert(feedItemObservations)
      .values(batch)
      .onConflictDoUpdate({
        target: [feedItemObservations.itemId, feedItemObservations.kind],
        set: {
          value: sql`excluded.value`,
          digest: sql`excluded.digest`,
          imagePending: sql`excluded.image_pending`,
        },
      });
  for (const batch of slices(writes.aliases, 100))
    // Bound each statement and preserve transaction order.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await tx
      .insert(feedItemAliases)
      .values(batch)
      .onConflictDoUpdate({
        target: [feedItemAliases.feedId, feedItemAliases.locator],
        set: { itemId: sql`excluded.item_id` },
      });
  return written;
}

function inWriteTransaction<T>(
  database: typeof db,
  write: (transaction: FeedDatabase) => Promise<T>,
) {
  return runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(write, { behavior: "immediate" }),
    ),
  );
}

/**
 * Reads the matched items outside the transaction, where their bodies do not
 * hold the writer lock, then writes only if a narrow reread inside it finds
 * the same state. `stale` asks the caller to read again.
 */
async function writeIfUnchanged(
  database: typeof db,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  incoming: IncomingObservation[],
) {
  const observations = incoming.map((entry) => entry.observation);
  const matched = await loadMatchedItems(database, feed.id, observations);
  const writes = planItemWrites(feed.id, matched, incoming, new Date());
  if (writesNothing(writes)) return NOTHING_WRITTEN;
  const written = await inWriteTransaction(database, async (tx) =>
    sameIdentity(matched, await readItemIdentity(tx, feed.id, observations))
      ? applyItemWrites(tx, writes)
      : ("stale" as const),
  );
  return written === "stale" ? written : writtenItems(feed, written, writes);
}

/** Reads and writes under one lock: for writers that guard their commit, and when rereads keep losing. */
function writeInOneTransaction(
  database: typeof db,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  incoming: IncomingObservation[],
  commit?: CommitGuards,
) {
  return inWriteTransaction(database, async (tx) => {
    if (commit && !(await commit.canWrite(tx))) return NOTHING_WRITTEN;
    const writes = planItemWrites(
      feed.id,
      await loadMatchedItems(
        tx,
        feed.id,
        incoming.map((entry) => entry.observation),
      ),
      incoming,
      new Date(),
    );
    const written = await applyItemWrites(tx, writes);
    await commit?.didWrite(tx);
    return writtenItems(feed, written, writes);
  });
}

function writtenItems(
  feed: Pick<DatabaseFeed, "platform">,
  written: DatabaseFeedItem[],
  writes: ItemWrites,
) {
  return {
    items: written.map((item) => toApplicationFeedItem(item, feed.platform)),
    removedItemIds: writes.removedItemIds,
  };
}

/**
 * Writes identity, observations, aliases and the visible composite for one
 * batch. A writer with commit guards runs wholly inside its transaction. Any
 * other reads first and holds the writer lock only to verify and write.
 */
export async function writeIncomingObservations(
  database: typeof db,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  incoming: IncomingObservation[],
  commit?: CommitGuards,
) {
  if (!incoming.length) return NOTHING_WRITTEN;
  if (commit) return writeInOneTransaction(database, feed, incoming, commit);
  for (let attempt = 0; attempt < OPTIMISTIC_ATTEMPTS; attempt++) {
    // Each attempt rereads what the previous one found changed.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const written = await writeIfUnchanged(database, feed, incoming);
    if (written !== "stale") return written;
  }
  return writeInOneTransaction(database, feed, incoming);
}

export function writeObservedItems(
  database: typeof db,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  incoming: ItemObservation[],
  commit?: CommitGuards,
) {
  return writeIncomingObservations(
    database,
    feed,
    incoming.map((observation) => ({
      observation,
      digest: observationDigest(observation),
    })),
    commit,
  );
}

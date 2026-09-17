import { createId } from "@paralleldrive/cuid2";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { runDatabaseWrite } from "../db/retry-write";
import {
  feedItemAliases,
  feedItemObservations,
  feedItemPageImages,
  feedItems,
} from "../db/schema";
import { buildConflictUpdateColumns } from "../db/utils";
import { composeItem, legacyObservation } from "./itemObservation";
import { computeItemHash } from "./hash";
import { resolveItemDate } from "./publishedDate";
import type { ItemObservation } from "./itemObservation";
import type { db } from "../db";
import type {
  ApplicationFeedItem,
  DatabaseFeed,
  DatabaseFeedItem,
} from "../db/schema";
import { dbSemaphore } from "~/lib/semaphore";

type Sources = Partial<Record<ItemObservation["kind"], ItemObservation>>;

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

/** One write transaction owns identity, snapshots, aliases, and the visible composite. */
export async function writeObservedItems(
  database: typeof db,
  feed: DatabaseFeed,
  incoming: ItemObservation[],
) {
  if (!incoming.length) return { items: [], removedItemIds: [] as string[] };
  return runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(
        async (tx) => {
          const locators = [
            ...new Set(
              incoming.flatMap((item) =>
                item.kind === "atproto"
                  ? [item.url, `atproto:${item.key}`]
                  : [item.url],
              ),
            ),
          ];
          const aliases = await tx
            .select()
            .from(feedItemAliases)
            .where(
              and(
                eq(feedItemAliases.feedId, feed.id),
                inArray(feedItemAliases.locator, locators),
              ),
            );
          const aliasIds = [...new Set(aliases.map((alias) => alias.itemId))];
          const atprotoUris = incoming
            .filter((item) => item.kind === "atproto")
            .map((item) => item.key);
          // Separate indexed branches avoid scanning the Feed for an OR predicate.
          const selectMatches = (condition: ReturnType<typeof inArray>) =>
            tx
              .select({
                ...getTableColumns(feedItems),
                pageImage: feedItemPageImages,
              })
              .from(feedItems)
              .leftJoin(
                feedItemPageImages,
                eq(feedItemPageImages.itemId, feedItems.id),
              )
              .where(and(eq(feedItems.feedId, feed.id), condition));
          let matches = selectMatches(inArray(feedItems.url, locators))
            .union(selectMatches(inArray(feedItems.normalizedUrl, locators)))
            .$dynamic();
          if (aliasIds.length)
            matches = matches.union(
              selectMatches(inArray(feedItems.id, aliasIds)),
            );
          if (atprotoUris.length)
            matches = matches.union(
              selectMatches(inArray(feedItems.atprotoUri, atprotoUris)),
            );
          const matchedRows = await matches;
          const existing = matchedRows.map(({ pageImage, ...item }) => {
            void pageImage;
            return item;
          });
          const ids = existing.map((item) => item.id);
          const persistedIds = new Set(ids);
          const observations = ids.length
            ? await tx
                .select()
                .from(feedItemObservations)
                .where(inArray(feedItemObservations.itemId, ids))
            : [];
          const images = new Map(
            matchedRows.flatMap((row) =>
              row.pageImage ? [[row.id, row.pageImage] as const] : [],
            ),
          );
          const imageWrites = new Map<
            string,
            typeof feedItemPageImages.$inferInsert
          >();
          const rows = new Map(existing.map((item) => [item.id, item]));
          const sources = new Map<string, Sources>();
          for (const observation of observations) {
            const values = sources.get(observation.itemId) ?? {};
            values[observation.kind] = observation.value;
            sources.set(observation.itemId, values);
          }
          for (const item of existing) {
            if (!sources.has(item.id))
              sources.set(item.id, { rss: legacyObservation(item) });
          }
          const lookup = new Map(
            aliases.map((alias) => [alias.locator, alias.itemId]),
          );
          for (const item of existing) {
            lookup.set(item.url, item.id);
            if (item.normalizedUrl) lookup.set(item.normalizedUrl, item.id);
            if (item.atprotoUri)
              lookup.set(`atproto:${item.atprotoUri}`, item.id);
          }
          const changed = new Map<string, typeof feedItems.$inferInsert>();
          const touched = new Set<string>();
          const removedItemIds: string[] = [];
          const replacements = new Map<string, string>();
          const now = new Date();
          for (const observation of incoming) {
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
              for (const [locator, target] of lookup)
                if (target === otherId) lookup.set(locator, id);
              for (const [loser, winner] of replacements)
                if (winner === otherId) replacements.set(loser, id);
              replacements.set(otherId, id);
              removedItemIds.push(otherId);
              changed.delete(otherId);
              imageWrites.delete(otherId);
              touched.delete(otherId);
              rows.delete(otherId);
              sources.delete(otherId);
            }
            const previousExplicitImage =
              values.atproto?.thumbnail || values.rss?.thumbnail;
            values[observation.kind] =
              observation.kind === "rss" &&
              !Number.isFinite(new Date(observation.publishedAt).getTime())
                ? {
                    ...observation,
                    publishedAt: resolveItemDate(
                      new Date(observation.publishedAt),
                      values.rss?.publishedAt
                        ? new Date(values.rss.publishedAt)
                        : row?.postedAt,
                      now,
                    ).toISOString(),
                  }
                : observation;
            sources.set(id, values);
            touched.add(id);
            const pageUrl = composeItem(values.rss, values.atproto).url;
            const image = images.get(id);
            const validImage =
              image?.pageUrl === pageUrl ? image.imageUrl : null;
            const composed = composeItem(
              values.rss,
              values.atproto,
              validImage,
            );
            if (
              !image ||
              image.pageUrl !== pageUrl ||
              (previousExplicitImage &&
                !(values.atproto?.thumbnail || values.rss?.thumbnail))
            ) {
              const state = {
                itemId: id,
                feedId: feed.id,
                pageUrl,
                imageUrl: validImage,
                nextCheckAt: new Date(0),
              };
              images.set(id, state);
              imageWrites.set(id, state);
            }
            const value = {
              ...row,
              ...composed,
              id,
              feedId: feed.id,
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
          // Move aliases before deleting collided rows, whose snapshots cascade away.
          for (const [loser, winner] of replacements) {
            if (persistedIds.has(winner)) {
              // Transfer aliases before their old owner is deleted.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              await tx
                .update(feedItemAliases)
                .set({ itemId: winner })
                .where(eq(feedItemAliases.itemId, loser));
            } else {
              // A winner created in this batch does not exist yet. Carry the
              // loser's historical aliases across its cascading deletion.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              const inheritedAliases = await tx
                .select()
                .from(feedItemAliases)
                .where(eq(feedItemAliases.itemId, loser));
              for (const alias of inheritedAliases)
                lookup.set(alias.locator, winner);
            }
            // Free the colliding URL before writing the surviving item.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await tx.delete(feedItems).where(eq(feedItems.id, loser));
          }
          const written: DatabaseFeedItem[] = [];
          const changes = [...changed.values()];
          // Keep each statement below SQLite's host-parameter limit.
          for (let offset = 0; offset < changes.length; offset += 25) {
            // Keep statement order inside the single writer transaction.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const batch = await tx
              .insert(feedItems)
              .values(changes.slice(offset, offset + 25))
              .onConflictDoUpdate({
                target: feedItems.id,
                set: buildConflictUpdateColumns(feedItems, [
                  "contentId",
                  "url",
                  "normalizedUrl",
                  "title",
                  "author",
                  "content",
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
              .returning();
            written.push(...batch);
          }
          const imageChanges = [...imageWrites.values()];
          for (let offset = 0; offset < imageChanges.length; offset += 100) {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await tx
              .insert(feedItemPageImages)
              .values(imageChanges.slice(offset, offset + 100))
              .onConflictDoUpdate({
                target: feedItemPageImages.itemId,
                set: {
                  pageUrl: sql`excluded.page_url`,
                  imageUrl: sql`excluded.image_url`,
                  nextCheckAt: sql`excluded.next_check_at`,
                },
              });
          }
          const previousSnapshots = new Map(
            observations.map((entry) => [
              `${entry.itemId}:${entry.kind}`,
              JSON.stringify(entry.value),
            ]),
          );
          const snapshots = [...touched].flatMap((id) =>
            Object.values(sources.get(id)!)
              .filter(
                (value) =>
                  previousSnapshots.get(`${id}:${value.kind}`) !==
                  JSON.stringify(value),
              )
              .map((value) => ({ itemId: id, kind: value.kind, value })),
          );
          for (let offset = 0; offset < snapshots.length; offset += 100) {
            // Bound each statement and preserve transaction order.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await tx
              .insert(feedItemObservations)
              .values(snapshots.slice(offset, offset + 100))
              .onConflictDoUpdate({
                target: [
                  feedItemObservations.itemId,
                  feedItemObservations.kind,
                ],
                set: { value: sql`excluded.value` },
              });
          }
          const previousAliases = new Map(
            aliases.map((alias) => [alias.locator, alias.itemId]),
          );
          const aliasWrites = [...lookup]
            .filter(
              ([locator, id]) =>
                touched.has(id) && previousAliases.get(locator) !== id,
            )
            .map(([locator, itemId]) => ({ feedId: feed.id, locator, itemId }));
          for (let offset = 0; offset < aliasWrites.length; offset += 100) {
            // Bound each statement and preserve transaction order.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await tx
              .insert(feedItemAliases)
              .values(aliasWrites.slice(offset, offset + 100))
              .onConflictDoUpdate({
                target: [feedItemAliases.feedId, feedItemAliases.locator],
                set: { itemId: sql`excluded.item_id` },
              });
          }
          return {
            items: written.map(
              (item) =>
                ({ ...item, platform: feed.platform }) as ApplicationFeedItem,
            ),
            removedItemIds,
          };
        },
        { behavior: "immediate" },
      ),
    ),
  );
}

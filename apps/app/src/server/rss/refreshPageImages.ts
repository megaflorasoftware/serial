import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { JSDOM } from "jsdom";
import { openGraphImageUrl } from "@serial/bookmark-capture";
import {
  feedItemObservations,
  feedItemPageImages,
  feedItems,
} from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { readFeedHttp } from "./feedHttp";
import { composeItem, legacyObservation } from "./itemObservation";
import { computeItemHash } from "./hash";
import type { db } from "../db";
import type {
  ApplicationFeedItem,
  DatabaseFeed,
  DatabaseFeedItem,
} from "../db/schema";
import type { ItemObservation } from "./itemObservation";
import { workerPool } from "~/lib/workerPool";
import { dbSemaphore } from "~/lib/semaphore";

export const PAGE_IMAGE_BATCH_SIZE = 8;
export const PAGE_IMAGE_CONCURRENCY = 2;
const RETRY_MS = 60 * 60 * 1000;
const RECHECK_MS = 7 * 24 * RETRY_MS;

async function fetchPageImage(url: string, readPage: typeof readFeedHttp) {
  if (
    !URL.canParse(url) ||
    !["https:", "http:"].includes(new URL(url).protocol)
  )
    return { imageUrl: null, failed: false };
  try {
    const response = await readPage(url, {
      maxBodyBytes: 256 * 1024,
      totalDurationMs: 3_000,
    });
    if (!response.ok) return { failed: true };
    const dom = new JSDOM(response.text);
    try {
      return {
        imageUrl: openGraphImageUrl(dom.window.document, response.url) ?? null,
        failed: false,
      };
    } finally {
      dom.window.close();
    }
  } catch {
    return { failed: true };
  }
}

function sourcesFor(item: DatabaseFeedItem, observations: ItemObservation[]) {
  const sources = new Map(
    observations.map((observation) => [observation.kind, observation]),
  );
  if (!sources.size) sources.set("rss", legacyObservation(item));
  return { rss: sources.get("rss"), document: sources.get("atproto") };
}

/** Claim an indexed batch, fetch outside the transaction, then apply against current observations. */
export async function refreshPageImages(
  database: typeof db,
  feed: DatabaseFeed,
  readPage: typeof readFeedHttp = readFeedHttp,
) {
  const now = new Date();
  const lease = new Date(now.getTime() + RETRY_MS);
  const candidates = await runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(
        async (tx) => {
          const due = await tx
            .select()
            .from(feedItemPageImages)
            .where(
              and(
                eq(feedItemPageImages.feedId, feed.id),
                lte(feedItemPageImages.nextCheckAt, now),
              ),
            )
            .orderBy(
              asc(feedItemPageImages.nextCheckAt),
              asc(feedItemPageImages.itemId),
            )
            .limit(PAGE_IMAGE_BATCH_SIZE);
          if (!due.length) return [];
          const ids = due.map((entry) => entry.itemId);
          await tx
            .update(feedItemPageImages)
            .set({ nextCheckAt: lease })
            .where(inArray(feedItemPageImages.itemId, ids));
          const [items, observations] = await Promise.all([
            tx.select().from(feedItems).where(inArray(feedItems.id, ids)),
            tx
              .select()
              .from(feedItemObservations)
              .where(inArray(feedItemObservations.itemId, ids)),
          ]);
          const itemsById = new Map(items.map((item) => [item.id, item]));
          return due.flatMap((entry) => {
            const item = itemsById.get(entry.itemId);
            if (!item) return [];
            const sources = sourcesFor(
              item,
              observations
                .filter((row) => row.itemId === item.id)
                .map((row) => row.value),
            );
            return [
              {
                ...entry,
                explicitImage:
                  sources.document?.thumbnail || sources.rss?.thumbnail,
              },
            ];
          });
        },
        { behavior: "immediate" },
      ),
    ),
  );

  const results: Array<{
    candidate: (typeof candidates)[number];
    result: Awaited<ReturnType<typeof fetchPageImage>>;
  }> = [];
  for await (const result of workerPool(
    candidates,
    PAGE_IMAGE_CONCURRENCY,
    async (candidate) => ({
      candidate,
      result: candidate.explicitImage
        ? { failed: false, imageUrl: candidate.imageUrl }
        : await fetchPageImage(candidate.pageUrl, readPage),
    }),
  ))
    results.push(result);
  if (!results.length) return [];

  return runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(
        async (tx) => {
          const ids = results.map(({ candidate }) => candidate.itemId);
          const [currentImages, items, observations] = await Promise.all([
            tx
              .select()
              .from(feedItemPageImages)
              .where(inArray(feedItemPageImages.itemId, ids)),
            tx.select().from(feedItems).where(inArray(feedItems.id, ids)),
            tx
              .select()
              .from(feedItemObservations)
              .where(inArray(feedItemObservations.itemId, ids)),
          ]);
          const imagesById = new Map(
            currentImages.map((entry) => [entry.itemId, entry]),
          );
          const itemsById = new Map(items.map((item) => [item.id, item]));
          const changed: ApplicationFeedItem[] = [];
          const legacySnapshots: Array<
            typeof feedItemObservations.$inferInsert
          > = [];
          for (const { candidate, result } of results) {
            const current = imagesById.get(candidate.itemId);
            const item = itemsById.get(candidate.itemId);
            if (
              !current ||
              !item ||
              current.pageUrl !== candidate.pageUrl ||
              current.nextCheckAt.getTime() !== lease.getTime()
            )
              continue;
            const imageUrl = result.failed
              ? current.imageUrl
              : (result.imageUrl ?? null);
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await tx
              .update(feedItemPageImages)
              .set({
                imageUrl,
                nextCheckAt: new Date(
                  now.getTime() + (result.failed ? RETRY_MS : RECHECK_MS),
                ),
              })
              .where(eq(feedItemPageImages.itemId, item.id));
            const sources = sourcesFor(
              item,
              observations
                .filter((row) => row.itemId === item.id)
                .map((row) => row.value),
            );
            if (!observations.some((row) => row.itemId === item.id)) {
              // Preserve the legacy fallback before replacing the visible thumbnail.
              legacySnapshots.push({
                itemId: item.id,
                kind: "rss",
                value: sources.rss!,
              });
            }
            const composed = composeItem(
              sources.rss,
              sources.document,
              imageUrl,
            );
            if (composed.thumbnail === item.thumbnail) continue;
            const update = {
              thumbnail: composed.thumbnail,
              updatedAt: now,
              contentHash: computeItemHash({
                ...composed,
                content: JSON.stringify(composed),
              }),
            };
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            await tx
              .update(feedItems)
              .set(update)
              .where(eq(feedItems.id, item.id));
            changed.push({
              ...item,
              ...update,
              platform: feed.platform,
            } as ApplicationFeedItem);
          }
          if (legacySnapshots.length)
            await tx.insert(feedItemObservations).values(legacySnapshots);
          return changed;
        },
        { behavior: "immediate" },
      ),
    ),
  );
}

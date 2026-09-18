import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  buildBlueskyCdnImageUrl,
  documentBelongsToPublication,
  listedRecordSchema,
  parseDocumentRecord,
  parseDocumentUri,
  parsePublicationRecord,
  parsePublicationUri,
} from "@serial/standard-site";
import { runDatabaseWrite } from "../db/retry-write";
import {
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feedOrigins,
} from "../db/schema";
import { documentObservation } from "./documentObservation";
import { enrichObservationImages } from "./observationImages";
import { readFeedHttp } from "./feedHttp";
import {
  createPublicationClient,
  MissingPublicationRecordError,
} from "./atprotoClient";
import { writeObservedItems } from "./writeItems";
import { refreshOriginMetadata } from "./originMetadata";
import { calculateNextFetch } from "./calculateNextFetch";
import {
  ATMOSPHERE_DOCUMENT_CONCURRENCY,
  ATMOSPHERE_DOCUMENTS_PER_REFRESH,
  ATMOSPHERE_INITIAL_ITEMS,
  ATMOSPHERE_PAGES_PER_REFRESH,
} from "./atmospherePolicy";
import type { ItemObservation } from "./itemObservation";
import type { PublicationClient } from "./atprotoClient";
import type { db } from "../db";
import type { ApplicationFeedItem } from "../db/schema";
import type { FetchableOrigin } from "./types";
import { workerPool } from "~/lib/workerPool";
import { logWarning } from "~/server/logger";
import { dbSemaphore } from "~/lib/semaphore";

export {
  ATMOSPHERE_INITIAL_ITEMS,
  ATMOSPHERE_PAGES_PER_REFRESH,
  ATMOSPHERE_DOCUMENT_CONCURRENCY,
  ATMOSPHERE_DOCUMENTS_PER_REFRESH,
} from "./atmospherePolicy";

export async function ingestAtmosphere(
  database: typeof db,
  fetchable: FetchableOrigin,
  client: PublicationClient = createPublicationClient(),
  readPage: typeof readFeedHttp = readFeedHttp,
  staging?: {
    guard: import("drizzle-orm").SQL;
    signal: AbortSignal;
    publication: (
      record: NonNullable<ReturnType<typeof parsePublicationRecord>>,
    ) => Promise<void>;
    records: (
      records: Array<typeof listedRecordSchema._output>,
      rev: string | null,
    ) => Promise<void>;
  },
) {
  const { origin, feed } = fetchable;
  const publicationUri = parsePublicationUri(origin.locator);
  if (!publicationUri) throw new Error("Invalid publication URI");
  const now = new Date();
  if (!origin.atproto) throw new Error("Missing AT Protocol origin details");
  const state = {
    cursor: origin.atproto.cursor,
    boundary: origin.atproto.boundary,
    newestRkey: origin.atproto.newestRkey,
    pendingRev: origin.atproto.pendingRev,
    retryCursor: origin.atproto.retryCursor,
    initialCount: origin.atproto.initialCount,
    initialized: origin.atproto.initialized,
  };
  const rev = await client.latestRev(publicationUri.did);
  const retryWhere = and(
    eq(feedOriginAtprotoDocuments.originId, origin.id),
    eq(feedOriginAtprotoDocuments.status, "retry"),
  );
  const retries = staging
    ? []
    : await dbSemaphore.run(async () => {
        const afterCursor = await database
          .select()
          .from(feedOriginAtprotoDocuments)
          .where(
            state.retryCursor
              ? and(
                  retryWhere,
                  gt(feedOriginAtprotoDocuments.uri, state.retryCursor),
                )
              : retryWhere,
          )
          .orderBy(asc(feedOriginAtprotoDocuments.uri))
          .limit(100);
        if (!state.retryCursor || afterCursor.length === 100)
          return afterCursor;
        const wrapped = await database
          .select()
          .from(feedOriginAtprotoDocuments)
          .where(
            and(
              retryWhere,
              lte(feedOriginAtprotoDocuments.uri, state.retryCursor),
            ),
          )
          .orderBy(asc(feedOriginAtprotoDocuments.uri))
          .limit(100 - afterCursor.length);
        return [...afterCursor, ...wrapped];
      });
  if (retries.length) state.retryCursor = retries.at(-1)!.uri;
  if (
    !staging &&
    state.initialized &&
    !state.cursor &&
    !retries.length &&
    rev &&
    rev === origin.atproto.repoRev
  ) {
    await runDatabaseWrite(database, () =>
      database
        .update(feedOrigins)
        .set({ lastFetchedAt: now, nextFetchAt: calculateNextFetch({}, now) })
        .where(eq(feedOrigins.id, origin.id)),
    );
    return { status: "skipped" as const, id: feed.id, originId: origin.id };
  }
  const publication = parsePublicationRecord(
    await client.getRecord(origin.locator),
  );
  if (!publication || publication.uri !== origin.locator)
    throw new Error("Invalid publication record");
  const publicationChanged =
    origin.sourceName !== publication.value.name ||
    feed.siteUrl !== publication.value.url;
  const metadataChanged = staging
    ? (await staging.publication(publication), false)
    : await refreshOriginMetadata(database, fetchable, {
        name: publication.value.name,
        imageUrl: publication.value.icon
          ? buildBlueskyCdnImageUrl(
              publicationUri.did,
              publication.value.icon.ref.$link,
              "avatar",
            )
          : null,
        description: publication.value.description,
        siteUrl: publication.value.url,
      });
  const items = new Map<string, ApplicationFeedItem>();
  const removedItemIds = new Set<string>();
  let failed = false;
  let processedDocuments = 0;
  let firstEtag = origin.atproto.listingEtag;
  const continuing = Boolean(state.cursor);
  const previousNewest = state.newestRkey;
  if (!continuing) {
    state.boundary = state.initialized ? state.newestRkey : null;
    state.pendingRev = rev;
  }

  async function processRecords(records: unknown[], countInitial: boolean) {
    const envelopes = records.flatMap((input) => {
      const parsed = listedRecordSchema.safeParse(input);
      const uri = parsed.success && parseDocumentUri(parsed.data.uri);
      if (parsed.success && uri && uri.did === publicationUri!.did)
        return [parsed.data];
      logWarning("Skipping invalid publication document envelope", {
        uri:
          parsed.success && typeof parsed.data.uri === "string"
            ? parsed.data.uri.slice(0, 512)
            : undefined,
      });
      return [];
    });
    const existing = envelopes.length
      ? await database
          .select()
          .from(feedOriginAtprotoDocuments)
          .where(
            and(
              eq(feedOriginAtprotoDocuments.originId, origin.id),
              inArray(
                feedOriginAtprotoDocuments.uri,
                envelopes.map((record) => record.uri),
              ),
            ),
          )
      : [];
    const known = new Map(existing.map((record) => [record.uri, record]));
    let initialCount = state.initialCount;
    const statuses: Array<typeof feedOriginAtprotoDocuments.$inferInsert> = [];
    const candidates = envelopes.filter((record) => {
      const old = known.get(record.uri);
      if (
        old?.cid === record.cid &&
        old.status !== "retry" &&
        !publicationChanged
      )
        return false;
      const parsed = parseDocumentRecord(record);
      if (
        parsed &&
        !documentBelongsToPublication(parsed.value.site, origin.locator)
      ) {
        if (old?.status === "retry") {
          statuses.push({
            originId: origin.id,
            uri: record.uri,
            cid: record.cid,
            status: "invalid",
          });
          logWarning("Skipping publication document moved to another site", {
            uri: record.uri,
          });
        }
        return false;
      }
      if (countInitial && !state.initialized && !old && parsed) {
        if (initialCount >= ATMOSPHERE_INITIAL_ITEMS) return false;
        initialCount++;
      }
      return true;
    });
    if (staging) {
      await staging.records(candidates, rev);
      state.initialCount = initialCount;
      processedDocuments += candidates.length;
      return new Set(existing.map((entry) => entry.uri));
    }
    const observations: ItemObservation[] = [];
    processedDocuments += candidates.length;
    for await (const result of workerPool(
      candidates,
      ATMOSPHERE_DOCUMENT_CONCURRENCY,
      async (record) => {
        const base = { originId: origin.id, uri: record.uri, cid: record.cid };
        const document = parseDocumentRecord(record);
        if (
          !document ||
          !Number.isFinite(Date.parse(document.value.publishedAt))
        ) {
          logWarning("Skipping invalid publication document", {
            uri: record.uri,
          });
          return { ...base, status: "invalid" as const };
        }
        try {
          const observation = await documentObservation(
            document,
            publication!,
            publicationUri!.did,
            client,
          );
          return { ...base, status: "ready" as const, observation };
        } catch (error) {
          failed = true;
          logWarning("Publication document will be retried", {
            uri: record.uri,
            error: String(error),
          });
          return { ...base, status: "retry" as const };
        }
      },
    )) {
      if ("observation" in result && result.observation)
        observations.push(result.observation);
      statuses.push({
        originId: result.originId,
        uri: result.uri,
        cid: result.cid,
        status: result.status,
      });
    }
    observations.sort(
      (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
    );
    const written = await writeObservedItems(
      database,
      feed,
      await enrichObservationImages(observations, readPage),
    );
    for (const id of written.removedItemIds) {
      removedItemIds.add(id);
      items.delete(id);
    }
    for (const item of written.items) items.set(item.id, item);
    if (statuses.length) {
      await runDatabaseWrite(database, () =>
        database.transaction(async (tx) => {
          await tx
            .insert(feedOriginAtprotoDocuments)
            .values(statuses)
            .onConflictDoUpdate({
              target: [
                feedOriginAtprotoDocuments.originId,
                feedOriginAtprotoDocuments.uri,
              ],
              set: { cid: sql`excluded.cid`, status: sql`excluded.status` },
            });
          await tx
            .update(feedOriginAtproto)
            .set({ ...state, initialCount })
            .where(
              and(eq(feedOriginAtproto.originId, origin.id), staging?.guard),
            );
        }),
      );
      state.initialCount = initialCount;
    }
    return new Set(existing.map((entry) => entry.uri));
  }

  // Failed records are fetched directly, even after they fall off the first repo page.
  const retryRecords: unknown[] = [];
  async function retireRetry(uri: string, message: string) {
    await runDatabaseWrite(database, () =>
      database
        .update(feedOriginAtprotoDocuments)
        .set({ status: "invalid" })
        .where(
          and(
            eq(feedOriginAtprotoDocuments.originId, origin.id),
            eq(feedOriginAtprotoDocuments.uri, uri),
          ),
        ),
    );
    logWarning(message, { uri });
  }
  for await (const record of workerPool(
    retries,
    ATMOSPHERE_DOCUMENT_CONCURRENCY,
    async (retry) => {
      try {
        const fetched = await client.getRecord(retry.uri);
        const parsed = listedRecordSchema.safeParse(fetched);
        if (!parsed.success || parsed.data.uri !== retry.uri) {
          await retireRetry(
            retry.uri,
            "Skipping invalid retried publication document",
          );
          return null;
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof MissingPublicationRecordError) {
          await retireRetry(retry.uri, "Skipping missing publication document");
        } else {
          failed = true;
        }
        return null;
      }
    },
  )) {
    if (record) retryRecords.push(record);
  }
  if (retryRecords.length) await processRecords(retryRecords, false);
  let cursor: string | null = null;
  let complete = false;
  try {
    for (
      let pageIndex = 0;
      pageIndex < ATMOSPHERE_PAGES_PER_REFRESH;
      pageIndex++
    ) {
      if (
        pageIndex > 0 &&
        processedDocuments + 100 > ATMOSPHERE_DOCUMENTS_PER_REFRESH
      )
        break;
      staging?.signal.throwIfAborted();
      const page = await client.list(
        publicationUri.did,
        cursor,
        pageIndex === 0 &&
          state.initialized &&
          !continuing &&
          !retries.length &&
          !publicationChanged
          ? origin.atproto.listingEtag
          : null,
      );
      if (pageIndex === 0) firstEtag = page.etag;
      if (page.notModified) {
        complete = true;
        break;
      }
      const rkeys = page.records.flatMap((record) => {
        const parsed = listedRecordSchema.safeParse(record);
        const uri = parsed.success ? parseDocumentUri(parsed.data.uri) : null;
        return uri?.did === publicationUri.did ? [uri.rkey] : [];
      });
      if (pageIndex === 0 && rkeys[0]) state.newestRkey = rkeys[0];
      // Always process the entire first page, even beyond the known boundary.
      const knownUris = await processRecords(page.records, true);
      const atBoundary =
        state.boundary &&
        [...knownUris].some((uri) => {
          const rkey = parseDocumentUri(uri)?.rkey;
          return rkey !== undefined && rkey <= state.boundary!;
        });
      if (continuing && pageIndex === 0) {
        cursor = state.cursor;
      } else if (
        !page.cursor ||
        atBoundary ||
        (!state.initialized && state.initialCount >= ATMOSPHERE_INITIAL_ITEMS)
      ) {
        complete = true;
        cursor = null;
      } else {
        if (page.cursor === cursor)
          throw new Error("Publication cursor did not advance");
        cursor = page.cursor;
      }
      state.cursor = cursor;
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set(state)
          .where(
            and(eq(feedOriginAtproto.originId, origin.id), staging?.guard),
          ),
      );
      if (complete) break;
    }
  } catch (error) {
    if (staging) throw error;
    failed = true;
    logWarning("Publication scan will be retried", {
      originId: origin.id,
      error: String(error),
    });
  }
  // Do not claim a repo revision until both the scan and all retries are complete.
  const pendingRetry = staging
    ? []
    : await database
        .select({ uri: feedOriginAtprotoDocuments.uri })
        .from(feedOriginAtprotoDocuments)
        .where(
          and(
            eq(feedOriginAtprotoDocuments.originId, origin.id),
            eq(feedOriginAtprotoDocuments.status, "retry"),
          ),
        )
        .limit(1);
  failed ||= pendingRetry.length > 0;
  if (complete) {
    state.initialized = true;
    state.cursor = null;
    state.boundary = null;
  }
  // A cycle resumed from a cursor records only the revision from its first page.
  const completedRev =
    complete && !failed ? state.pendingRev : origin.atproto.repoRev;
  if (!complete && !state.newestRkey) state.newestRkey = previousNewest;
  await runDatabaseWrite(database, () =>
    database.transaction(async (tx) => {
      await tx
        .update(feedOriginAtproto)
        .set({
          ...state,
          repoRev: completedRev,
          listingEtag: complete && !failed ? firstEtag : null,
        })
        .where(and(eq(feedOriginAtproto.originId, origin.id), staging?.guard));
      if (!staging)
        await tx
          .update(feedOrigins)
          .set({
            lastFetchedAt: now,
            nextFetchAt: failed
              ? new Date(now.getTime() + 3_600_000)
              : calculateNextFetch({}, now),
          })
          .where(eq(feedOrigins.id, origin.id));
    }),
  );
  return {
    status: failed
      ? ("error" as const)
      : items.size
        ? ("success" as const)
        : ("empty" as const),
    id: feed.id,
    originId: origin.id,
    feedItems: [...items.values()].filter(
      (item) => !removedItemIds.has(item.id),
    ),
    removedItemIds: [...removedItemIds],
    metadataChanged,
    ...(failed
      ? { error: new Error("Some publication documents will be retried") }
      : {}),
  };
}

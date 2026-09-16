import { and, eq, inArray, sql } from "drizzle-orm";
import {
  buildBlueskyCdnImageUrl,
  buildCanonicalDocumentUrl,
  convertDocumentContent,
  documentBelongsToPublication,
  listedRecordSchema,
  parseDocumentRecord,
  parseDocumentUri,
  parsePublicationRecord,
  parsePublicationUri,
  sanitizeEmbeddedHtml,
} from "@serial/standard-site";
import {
  feedDocumentRecords,
  feedIngestState,
  feedOrigins,
} from "../db/schema";
import {
  createPublicationClient,
  MissingPublicationRecordError,
} from "./atprotoClient";
import { writeObservedItems } from "./writeItems";
import { refreshOriginMetadata } from "./originMetadata";
import { boundFeedItems } from "./feedBounds";
import { itemUrl } from "./itemObservation";
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
) {
  const { origin, feed } = fetchable;
  const publicationUri = parsePublicationUri(origin.locator);
  if (!publicationUri) throw new Error("Invalid publication URI");
  const now = new Date();
  const [saved, retries, rev] = await Promise.all([
    dbSemaphore.run(() =>
      database
        .select()
        .from(feedIngestState)
        .where(eq(feedIngestState.originId, origin.id))
        .get(),
    ),
    dbSemaphore.run(() =>
      database
        .select()
        .from(feedDocumentRecords)
        .where(
          and(
            eq(feedDocumentRecords.originId, origin.id),
            eq(feedDocumentRecords.status, "retry"),
          ),
        )
        .limit(100),
    ),
    client.latestRev(publicationUri.did),
  ]);
  const state = saved ?? {
    originId: origin.id,
    cursor: null,
    boundary: null,
    newestRkey: null,
    pendingRev: null,
    initialCount: 0,
    initialized: false,
  };
  if (
    state.initialized &&
    !state.cursor &&
    !retries.length &&
    rev &&
    rev === origin.repoRev
  ) {
    await database
      .update(feedOrigins)
      .set({ lastFetchedAt: now, nextFetchAt: calculateNextFetch({}, now) })
      .where(eq(feedOrigins.id, origin.id));
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
  const metadataChanged = await refreshOriginMetadata(database, fetchable, {
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
    pdsUrl: await client.resolvePds(publicationUri.did),
  });
  const items: ApplicationFeedItem[] = [];
  const removedItemIds: string[] = [];
  let failed = false;
  let processedDocuments = 0;
  let firstEtag = origin.etag;
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
      return parsed.success && uri && uri.did === publicationUri!.did
        ? [parsed.data]
        : [];
    });
    const existing = envelopes.length
      ? await database
          .select()
          .from(feedDocumentRecords)
          .where(
            and(
              eq(feedDocumentRecords.originId, origin.id),
              inArray(
                feedDocumentRecords.uri,
                envelopes.map((record) => record.uri),
              ),
            ),
          )
      : [];
    const known = new Map(existing.map((record) => [record.uri, record]));
    let initialCount = state.initialCount;
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
      )
        return false;
      if (countInitial && !state.initialized && !old && parsed) {
        if (initialCount >= ATMOSPHERE_INITIAL_ITEMS) return false;
        initialCount++;
      }
      return true;
    });
    const observations: ItemObservation[] = [];
    processedDocuments += candidates.length;
    const statuses: Array<typeof feedDocumentRecords.$inferInsert> = [];
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
          const converted = await convertDocumentContent(document.value, {
            did: publicationUri!.did,
            loadBlob: client.loadBlob,
            resolveRecord: client.resolveRecord,
          });
          const canonical = buildCanonicalDocumentUrl(
            publication!.value.url,
            document.value.path,
          );
          const observation: ItemObservation = {
            kind: "atproto",
            key: record.uri,
            url: itemUrl(canonical ?? record.uri),
            title: document.value.title,
            author:
              document.value.contributors
                ?.map((entry) => entry.displayName?.trim())
                .filter(Boolean)
                .join(", ") ?? "",
            description: document.value.description ?? "",
            thumbnail: document.value.coverImage
              ? (buildBlueskyCdnImageUrl(
                  publicationUri!.did,
                  document.value.coverImage.ref.$link,
                ) ?? "")
              : "",
            content: sanitizeEmbeddedHtml(
              boundFeedItems([
                {
                  id: record.uri,
                  title: "",
                  url: record.uri,
                  author: "",
                  publishedDate: document.value.publishedAt,
                  content: converted?.html ?? "",
                },
              ])[0]!.content ?? "",
            ),
            firstParagraph: converted?.firstParagraph ?? "",
            firstImageUrl: converted?.firstImageUrl ?? "",
            publishedAt: document.value.publishedAt,
            tags: document.value.tags ?? [],
            publicationName: publication!.value.name,
          };
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
    const written = await writeObservedItems(database, feed, observations);
    items.push(...written.items);
    removedItemIds.push(...written.removedItemIds);
    if (statuses.length) {
      await database.transaction(async (tx) => {
        await tx
          .insert(feedDocumentRecords)
          .values(statuses)
          .onConflictDoUpdate({
            target: [feedDocumentRecords.originId, feedDocumentRecords.uri],
            set: { cid: sql`excluded.cid`, status: sql`excluded.status` },
          });
        await tx
          .insert(feedIngestState)
          .values({ ...state, initialCount })
          .onConflictDoUpdate({
            target: feedIngestState.originId,
            set: { ...state, initialCount },
          });
      });
      state.initialCount = initialCount;
    }
    return new Set(existing.map((entry) => entry.uri));
  }

  // Failed records are fetched directly, even after they fall off the first repo page.
  const retryRecords: unknown[] = [];
  for await (const record of workerPool(
    retries,
    ATMOSPHERE_DOCUMENT_CONCURRENCY,
    async (retry) => {
      try {
        return await client.getRecord(retry.uri);
      } catch (error) {
        if (error instanceof MissingPublicationRecordError) {
          await database
            .update(feedDocumentRecords)
            .set({ status: "invalid" })
            .where(
              and(
                eq(feedDocumentRecords.originId, origin.id),
                eq(feedDocumentRecords.uri, retry.uri),
              ),
            );
          logWarning("Skipping missing publication document", {
            uri: retry.uri,
          });
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
      const page = await client.list(
        publicationUri.did,
        cursor,
        pageIndex === 0 &&
          state.initialized &&
          !continuing &&
          !retries.length &&
          !publicationChanged
          ? origin.etag
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
      await database
        .insert(feedIngestState)
        .values(state)
        .onConflictDoUpdate({ target: feedIngestState.originId, set: state });
      if (complete) break;
    }
  } catch (error) {
    failed = true;
    logWarning("Publication scan will be retried", {
      originId: origin.id,
      error: String(error),
    });
  }
  // Do not claim a repo revision until both the scan and all retries are complete.
  const pendingRetry = await database
    .select({ uri: feedDocumentRecords.uri })
    .from(feedDocumentRecords)
    .where(
      and(
        eq(feedDocumentRecords.originId, origin.id),
        eq(feedDocumentRecords.status, "retry"),
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
  const completedRev = complete && !failed ? state.pendingRev : origin.repoRev;
  if (!complete && !state.newestRkey) state.newestRkey = previousNewest;
  await database.transaction(async (tx) => {
    await tx
      .insert(feedIngestState)
      .values(state)
      .onConflictDoUpdate({ target: feedIngestState.originId, set: state });
    await tx
      .update(feedOrigins)
      .set({
        repoRev: completedRev,
        etag: complete && !failed ? firstEtag : null,
        lastFetchedAt: now,
        nextFetchAt: failed
          ? new Date(now.getTime() + 3_600_000)
          : calculateNextFetch({}, now),
      })
      .where(eq(feedOrigins.id, origin.id));
  });
  return {
    status: failed
      ? ("error" as const)
      : items.length
        ? ("success" as const)
        : ("empty" as const),
    id: feed.id,
    originId: origin.id,
    feedItems: items,
    removedItemIds,
    metadataChanged,
    ...(failed
      ? { error: new Error("Some publication documents will be retried") }
      : {}),
  };
}

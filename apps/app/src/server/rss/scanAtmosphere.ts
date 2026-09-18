import { and, eq, inArray } from "drizzle-orm";
import {
  documentBelongsToPublication,
  listedRecordSchema,
  parseDocumentRecord,
  parseDocumentUri,
  parsePublicationRecord,
  parsePublicationUri,
} from "@serial/standard-site";
import { runDatabaseWrite } from "../db/retry-write";
import { feedOriginAtproto, feedOriginAtprotoDocuments } from "../db/schema";
import {
  ATMOSPHERE_DOCUMENTS_PER_REFRESH,
  ATMOSPHERE_INITIAL_ITEMS,
  ATMOSPHERE_PAGES_PER_REFRESH,
} from "./atmospherePolicy";
import type { PublicationClient } from "./atprotoClient";
import type { SQL } from "drizzle-orm";
import type { db } from "../db";
import type { FetchableOrigin } from "./types";
import { logWarning } from "~/server/logger";

/** Stages bounded repository pages; Jetstream processing applies their content. */
export async function scanAtmosphere(
  database: typeof db,
  fetchable: FetchableOrigin,
  client: PublicationClient,
  staging: {
    guard: SQL;
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
  if (!origin.atproto) throw new Error("Missing AT Protocol origin details");
  const state = {
    cursor: origin.atproto.cursor,
    boundary: origin.atproto.boundary,
    newestRkey: origin.atproto.newestRkey,
    initialCount: origin.atproto.initialCount,
    initialized: origin.atproto.initialized,
  };
  const rev = await client.latestRev(publicationUri.did);
  const publication = parsePublicationRecord(
    await client.getRecord(origin.locator),
  );
  if (!publication || publication.uri !== origin.locator)
    throw new Error("Invalid publication record");
  const publicationChanged =
    origin.sourceName !== publication.value.name ||
    feed.siteUrl !== publication.value.url;
  await staging.publication(publication);
  let processedDocuments = 0;
  let firstEtag = origin.atproto.listingEtag;
  const continuing = Boolean(state.cursor);
  const previousNewest = state.newestRkey;
  if (!continuing) {
    state.boundary = state.initialized ? state.newestRkey : null;
  }

  async function stageRecords(records: unknown[]) {
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
        return false;
      }
      if (!state.initialized && !old && parsed) {
        if (initialCount >= ATMOSPHERE_INITIAL_ITEMS) return false;
        initialCount++;
      }
      return true;
    });
    await staging.records(candidates, rev);
    state.initialCount = initialCount;
    processedDocuments += candidates.length;
    return new Set(existing.map((entry) => entry.uri));
  }

  let cursor: string | null = null;
  let complete = false;
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
    staging.signal.throwIfAborted();
    const page = await client.list(
      publicationUri.did,
      cursor,
      pageIndex === 0 && state.initialized && !continuing && !publicationChanged
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
    const knownUris = await stageRecords(page.records);
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
        .where(and(eq(feedOriginAtproto.originId, origin.id), staging.guard)),
    );
    if (complete) break;
  }
  if (complete) {
    state.initialized = true;
    state.cursor = null;
    state.boundary = null;
  }
  if (!complete && !state.newestRkey) state.newestRkey = previousNewest;
  await runDatabaseWrite(database, () =>
    database
      .update(feedOriginAtproto)
      .set({ ...state, listingEtag: complete ? firstEtag : null })
      .where(and(eq(feedOriginAtproto.originId, origin.id), staging.guard)),
  );
}

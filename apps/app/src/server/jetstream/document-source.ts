import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  bytesToBase64,
  DOCUMENT_SOURCE_BUDGET_BYTES,
  documentSourceBytes,
  parseLosslessJson,
  stringifyLosslessJson,
} from "@serial/standard-site";
import type { DocumentSource } from "@serial/standard-site";
import {
  feedOriginAtprotoDocumentBlobs,

  feedOriginAtprotoDocumentSources,
} from "../db/schema";
import type { FeedDatabase } from "../feeds/origins";

/**
 * A record captured before any lossy parse: the wire text of a JSON record, or
 * the lossless serialization of a DAG-CBOR record. `value` is the same record
 * parsed for validation and routing.
 */
export type CapturedRecord = { text: string; value: unknown };

/** Wire JSON keeps its digits; the parsed value is derived from the same text. */
export function captureRecordText(text: string): CapturedRecord {
  return { text, value: parseLosslessJson(text) };
}

/** Already-decoded records (CBOR archives, supplied envelopes) serialize losslessly. */
export function captureRecordValue(value: unknown): CapturedRecord {
  const text = stringifyLosslessJson(value);
  return { text, value: parseLosslessJson(text) };
}

export class OversizedDocumentSourceError extends Error {
  constructor() {
    super("Document source exceeds its retention budget");
  }
}

/** Throws when the record alone is over budget, before any blob is fetched. */
export function assertRecordWithinBudget(text: string) {
  if (documentSourceBytes({ record: text, blobs: [] }) > DOCUMENT_SOURCE_BUDGET_BYTES)
    throw new OversizedDocumentSourceError();
}

type DocumentKey = { originId: number; uri: string; cid: string };

/** Writes the staged record text for one version. Runs inside the caller's transaction. */
export async function stageDocumentSource(
  database: FeedDatabase,
  key: DocumentKey,
  record: string,
  now: Date,
) {
  await database
    .insert(feedOriginAtprotoDocumentSources)
    .values({ ...key, record, createdAt: now })
    .onConflictDoNothing();
}

/** Keeps the readable version and the version named; every other version goes. */
export async function pruneDocumentSources(
  database: FeedDatabase,
  key: { originId: number; uri: string },
  keep: Array<string | null>,
) {
  const cids = keep.filter((cid): cid is string => cid !== null);
  await database
    .delete(feedOriginAtprotoDocumentSources)
    .where(
      and(
        eq(feedOriginAtprotoDocumentSources.originId, key.originId),
        eq(feedOriginAtprotoDocumentSources.uri, key.uri),
        cids.length
          ? notInArray(feedOriginAtprotoDocumentSources.cid, cids)
          : undefined,
      ),
    );
}

export async function readStagedRecord(database: FeedDatabase, key: DocumentKey) {
  const row = await database
    .select({ record: feedOriginAtprotoDocumentSources.record })
    .from(feedOriginAtprotoDocumentSources)
    .where(
      and(
        eq(feedOriginAtprotoDocumentSources.originId, key.originId),
        eq(feedOriginAtprotoDocumentSources.uri, key.uri),
        eq(feedOriginAtprotoDocumentSources.cid, key.cid),
      ),
    )
    .get();
  return row ? captureRecordText(row.record) : null;
}

export type FetchedBlob = {
  cid: string;
  mimeType: string | null;
  bytes: Uint8Array;
};

/** Stores the overflow blobs for one version after the budget check passed. */
export async function storeDocumentBlobs(
  database: FeedDatabase,
  key: DocumentKey,
  blobs: FetchedBlob[],
) {
  if (!blobs.length) return;
  await database
    .insert(feedOriginAtprotoDocumentBlobs)
    .values(
      blobs.map((blob) => ({
        ...key,
        blobCid: blob.cid,
        mimeType: blob.mimeType,
        bytes: Buffer.from(blob.bytes),
      })),
    )
    .onConflictDoNothing();
}

type SourceKey = DocumentKey;

export function sourceKeyOf(key: SourceKey) {
  return `${key.originId}\n${key.uri}\n${key.cid}`;
}

/**
 * Sources and blobs for many versions in two statements. Keys are matched
 * exactly in memory after the columns are narrowed by their distinct values.
 */
export async function loadDocumentSources(
  database: FeedDatabase,
  keys: SourceKey[],
): Promise<Map<string, DocumentSource>> {
  const sources = new Map<string, DocumentSource>();
  if (!keys.length) return sources;
  const wanted = new Set(keys.map(sourceKeyOf));
  const distinct = <T>(values: T[]) => [...new Set(values)];
  const narrow = (table: {
    originId: SQLiteColumn;
    uri: SQLiteColumn;
    cid: SQLiteColumn;
  }) =>
    and(
      inArray(table.originId, distinct(keys.map((key) => key.originId))),
      inArray(table.uri, distinct(keys.map((key) => key.uri))),
      inArray(table.cid, distinct(keys.map((key) => key.cid))),
    );
  const rows = await database
    .select()
    .from(feedOriginAtprotoDocumentSources)
    .where(narrow(feedOriginAtprotoDocumentSources));
  for (const row of rows) {
    if (!wanted.has(sourceKeyOf(row))) continue;
    sources.set(sourceKeyOf(row), {
      uri: row.uri,
      cid: row.cid,
      record: row.record,
      blobs: [],
    });
  }
  if (!sources.size) return sources;
  const blobs = await database
    .select()
    .from(feedOriginAtprotoDocumentBlobs)
    .where(narrow(feedOriginAtprotoDocumentBlobs));
  for (const blob of blobs) {
    sources.get(sourceKeyOf(blob))?.blobs.push({
      cid: blob.blobCid,
      mimeType: blob.mimeType,
      bytes: bytesToBase64(new Uint8Array(blob.bytes)),
    });
  }
  return sources;
}

export async function loadDocumentSource(
  database: FeedDatabase,
  key: SourceKey,
) {
  return (await loadDocumentSources(database, [key])).get(sourceKeyOf(key)) ?? null;
}

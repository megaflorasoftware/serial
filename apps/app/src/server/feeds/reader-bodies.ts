import { and, eq, inArray, sql } from "drizzle-orm";
import {
  parseAtUri,
  READER_BODY_RESPONSE_BUDGET_BYTES,
  readerBodyBytes,
  REFERENCE_REFRESH_INTERVAL_MS,
} from "@serial/standard-site";
import { feedItems, feedOrigins, feeds } from "../db/schema";
import { loadDocumentSources, sourceKeyOf } from "../jetstream/document-source";
import {
  loadReferenceSnapshots,
  markReferenceSnapshotsRead,
  referenceReaders,
  resolveSourceReferences,
  sourceReferences,
} from "../jetstream/reference-snapshots";
import { sourceReaderBody } from "../rss/documentObservation";
import { createPublicationClient } from "../rss/atprotoClient";
import type { ApplicationFeedItem, DatabaseFeedItem } from "../db/schema";
import type {
  DocumentSource,
  ReaderBody,
  ReferenceSnapshot,
} from "@serial/standard-site";
import type { PublicationClient } from "../rss/atprotoClient";
import type { db } from "../db";

type BodyRow = Pick<
  DatabaseFeedItem,
  "id" | "feedId" | "content" | "contentHash" | "atprotoUri" | "sourceCid"
>;

/** What says where a body comes from and how large its stored HTML is, without the HTML. */
export type BodyHead = Omit<BodyRow, "content"> & { contentBytes: number };

export const bodyHeadColumns = {
  id: feedItems.id,
  feedId: feedItems.feedId,
  contentHash: feedItems.contentHash,
  atprotoUri: feedItems.atprotoUri,
  sourceCid: feedItems.sourceCid,
  // The size comes from the record header; the body itself is not read.
  contentBytes: sql<number>`octet_length(${feedItems.content})`,
};

/** The client item; lists and pages never carry a body, direct open and the body endpoint do. */
export function toApplicationFeedItem(
  row: DatabaseFeedItem,
  platform: string,
  body: ReaderBody | null = null,
): ApplicationFeedItem {
  const item: Record<string, unknown> = { ...row, platform, body };
  // The stored HTML and the normalization override are server-side columns.
  delete item.content;
  delete item.normalizedUrl;
  return item as ApplicationFeedItem;
}

function htmlBody(row: BodyRow): ReaderBody | null {
  return row.content.trim()
    ? { form: "html", html: row.content, revision: row.contentHash ?? "" }
    : null;
}

/** Feed items whose body is a retained source, keyed to the origin that holds it. */
async function sourceKeys(database: typeof db, rows: BodyRow[]) {
  const sourced = rows.filter((row) => row.sourceCid && row.atprotoUri);
  if (!sourced.length)
    return new Map<string, { originId: number; uri: string; cid: string }>();
  const origins = await database
    .select({ feedId: feedOrigins.feedId, originId: feedOrigins.id })
    .from(feedOrigins)
    .where(
      and(
        eq(feedOrigins.kind, "atproto"),
        inArray(feedOrigins.feedId, [
          ...new Set(sourced.map((row) => row.feedId)),
        ]),
      ),
    );
  const originByFeed = new Map(
    origins.map((row) => [row.feedId, row.originId]),
  );
  return new Map(
    sourced.flatMap((row) => {
      const originId = originByFeed.get(row.feedId);
      return originId === undefined
        ? []
        : [[row.id, { originId, uri: row.atprotoUri!, cid: row.sourceCid! }]];
    }),
  );
}

type SourcedRow = { source: DocumentSource; did: string };

/** Saved snapshots per source in render order; served rows are marked read. */
async function snapshotsFor(
  database: typeof db,
  bodies: SourcedRow[],
  now: Date,
) {
  const served = new Set<string>();
  const references = new Map<string, ReferenceSnapshot[]>();
  for (const { source, did } of bodies) {
    // Each body needs its own two-pass order; rows are cheap to reread by key.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const snapshots = await sourceReferences(database, source, did, (uris) =>
      loadReferenceSnapshots(database, uris),
    );
    for (const snapshot of snapshots) served.add(snapshot.uri);
    references.set(source.uri, snapshots);
  }
  await markReferenceSnapshotsRead(database, [...served], now);
  return references;
}

/**
 * Reader bodies for the given rows in the given order. Source bodies come
 * from retained sources plus their snapshots; everything else is HTML.
 */
export async function loadReaderBodies(
  database: typeof db,
  rows: BodyRow[],
  now = new Date(),
) {
  const keys = await sourceKeys(database, rows);
  const sources = await loadDocumentSources(database, [...keys.values()]);
  const withSource = rows.flatMap((row) => {
    const key = keys.get(row.id);
    const source = key && sources.get(sourceKeyOf(key));
    const did = source ? parseAtUri(source.uri)?.did : undefined;
    return source && did ? [{ row, source, did }] : [];
  });
  const references = await snapshotsFor(database, withSource, now);
  const sourceBodies = new Map(
    withSource.map(({ row, source }) => [
      row.id,
      sourceReaderBody(source, references.get(source.uri) ?? []),
    ]),
  );
  return new Map(
    rows.map((row) => [row.id, sourceBodies.get(row.id) ?? htmlBody(row)]),
  );
}

/** Bodies in request order until the response budget is spent; the rest are named. */
export function capReaderBodies<T extends { body: ReaderBody | null }>(
  entries: T[],
  budget = READER_BODY_RESPONSE_BUDGET_BYTES,
) {
  let bytes = 0;
  let cut = entries.length;
  for (const [index, entry] of entries.entries()) {
    bytes += entry.body ? readerBodyBytes(entry.body) : 0;
    // The first body always ships so one oversized body cannot starve a request.
    if (index > 0 && bytes > budget) {
      cut = index;
      break;
    }
  }
  return { items: entries.slice(0, cut), omitted: entries.slice(cut) };
}

/** Rows loaded per slice, so a request never materializes bodies it will not send. */
const BODY_LOAD_SLICE = 25;

/** A retained source ships in place of the stored HTML, at a size known only once loaded. */
function storedHtmlBytes(row: BodyHead) {
  return row.sourceCid && row.atprotoUri ? 0 : row.contentBytes;
}

/**
 * The leading rows whose stored HTML fits the budget. HTML ships at its stored
 * size, so a row past the budget is certain to be cut and its body is never
 * read. The first row always loads, as it always ships.
 */
function rowsKnownToFit<T extends BodyHead>(rows: T[], budget: number) {
  let bytes = 0;
  const cut = rows.findIndex((row, index) => {
    bytes += storedHtmlBytes(row);
    return index > 0 && bytes > budget;
  });
  return cut === -1 ? rows : rows.slice(0, cut);
}

/** The stored HTML of the given rows, in one statement. */
async function withStoredHtml<T extends BodyHead>(
  database: typeof db,
  rows: T[],
) {
  const stored = await database
    .select({ id: feedItems.id, content: feedItems.content })
    .from(feedItems)
    .where(
      inArray(
        feedItems.id,
        rows.map((row) => row.id),
      ),
    );
  const contentById = new Map(stored.map((row) => [row.id, row.content]));
  return rows.map((row) => ({
    ...row,
    content: contentById.get(row.id) ?? "",
  }));
}

/**
 * Loads bodies one slice at a time in request order and stops at the first
 * slice that crosses the response budget. Work stays bounded by the bytes
 * that ship, not by the number of ids asked for: a slice reads only the
 * stored HTML its sizes say can still fit.
 */
export async function loadCappedReaderBodies<T extends BodyHead>(
  database: typeof db,
  rows: T[],
  now = new Date(),
) {
  const items: Array<{ row: T; body: ReaderBody | null }> = [];
  let bytes = 0;
  for (let offset = 0; offset < rows.length; offset += BODY_LOAD_SLICE) {
    const slice = rows.slice(offset, offset + BODY_LOAD_SLICE);
    const remaining = READER_BODY_RESPONSE_BUDGET_BYTES - bytes;
    const fitting = rowsKnownToFit(slice, remaining);
    // Slices are sequential by design: the next one loads only if this one fit.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const loaded = await withStoredHtml(database, fitting);
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const bodies = await loadReaderBodies(database, loaded, now);
    const entries = fitting.map((row) => ({
      row,
      body: bodies.get(row.id) ?? null,
    }));
    const capped = capReaderBodies(entries, remaining);
    items.push(...capped.items);
    if (capped.omitted.length || fitting.length < slice.length) break;
    bytes += capped.items.reduce(
      (total, entry) => total + (entry.body ? readerBodyBytes(entry.body) : 0),
      0,
    );
  }
  return { items, omitted: rows.slice(items.length) };
}

/**
 * Refreshes a document's Reference snapshots at their latest versions.
 * Snapshots younger than the refresh interval are served as they are.
 */
export async function refreshDocumentReferences(
  database: typeof db,
  row: BodyRow,
  options: { now?: Date; client?: PublicationClient } = {},
): Promise<{ revision: string; references: ReferenceSnapshot[] } | null> {
  const now = options.now ?? new Date();
  const key = (await sourceKeys(database, [row])).get(row.id);
  const source = key
    ? (await loadDocumentSources(database, [key])).get(sourceKeyOf(key))
    : undefined;
  const did = source ? parseAtUri(source.uri)?.did : undefined;
  if (!source || !did) return null;
  const client = options.client ?? createPublicationClient();
  const references = await resolveSourceReferences(
    database,
    source,
    did,
    referenceReaders(client, 5_000),
    { now, reuseMs: REFERENCE_REFRESH_INTERVAL_MS },
  );
  await markReferenceSnapshotsRead(
    database,
    references.map((reference) => reference.uri),
    now,
  );
  return { revision: source.cid, references };
}

/** The one place a feed item row is looked up with its owner check for body work. */
export async function ownedBodyRow(
  database: typeof db,
  userId: string,
  id: string,
) {
  return database
    .select({
      id: feedItems.id,
      feedId: feedItems.feedId,
      content: feedItems.content,
      contentHash: feedItems.contentHash,
      atprotoUri: feedItems.atprotoUri,
      sourceCid: feedItems.sourceCid,
    })
    .from(feedItems)
    .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
    .where(and(eq(feedItems.id, id), eq(feeds.userId, userId)))
    .get();
}

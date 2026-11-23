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

/** A body head that may already carry its stored HTML. */
type RequestedBody = BodyHead & { content?: string };

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

/** The row names a retained source as its body. */
function namesSource(row: Pick<BodyRow, "sourceCid" | "atprotoUri">) {
  return Boolean(row.sourceCid && row.atprotoUri);
}

/** Feed items whose body is a retained source, keyed to the origin that holds it. */
async function sourceKeys(database: typeof db, rows: BodyRow[]) {
  const sourced = rows.filter(namesSource);
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

function shippedBytes(body: ReaderBody | null) {
  return body ? readerBodyBytes(body) : 0;
}

/**
 * How many leading entries fit the budget. The body that leads a response
 * ships whatever its size, so one oversized body cannot starve a request. No
 * later body does, or every slice could add one past the budget.
 */
function leadingFit<T>(
  entries: T[],
  bytesOf: (entry: T) => number,
  budget: number,
  leadsResponse: boolean,
) {
  let bytes = 0;
  const cut = entries.findIndex((entry, index) => {
    bytes += bytesOf(entry);
    return bytes > budget && !(leadsResponse && index === 0);
  });
  return cut === -1 ? entries.length : cut;
}

/**
 * Bodies in request order until the response budget is spent; the rest are
 * named. Entries that follow others in the same response do not lead it.
 */
export function capReaderBodies<T extends { body: ReaderBody | null }>(
  entries: T[],
  budget = READER_BODY_RESPONSE_BUDGET_BYTES,
  leadsResponse = true,
) {
  const cut = leadingFit(
    entries,
    (entry) => shippedBytes(entry.body),
    budget,
    leadsResponse,
  );
  return { items: entries.slice(0, cut), omitted: entries.slice(cut) };
}

/** Rows loaded per slice, so a request never materializes bodies it will not send. */
const BODY_LOAD_SLICE = 25;

/** A retained source ships in place of the stored HTML, at a size known only once loaded. */
function storedHtmlBytes(row: BodyHead) {
  return namesSource(row) ? 0 : row.contentBytes;
}

/**
 * The leading rows whose stored HTML fits the budget. HTML ships at its stored
 * size, so a row past the budget is certain to be cut and its body is never
 * read.
 */
function rowsKnownToFit<T extends BodyHead>(
  rows: T[],
  budget: number,
  leadsResponse: boolean,
) {
  return rows.slice(
    0,
    leadingFit(rows, storedHtmlBytes, budget, leadsResponse),
  );
}

/** The stored HTML of the given rows by id, in one statement; none for no rows. */
async function storedHtmlOf(database: typeof db, rows: BodyHead[]) {
  if (!rows.length) return new Map<string, string>();
  const stored = await database
    .select({ id: feedItems.id, content: feedItems.content })
    .from(feedItems)
    .where(
      inArray(
        feedItems.id,
        rows.map((row) => row.id),
      ),
    );
  return new Map(stored.map((row) => [row.id, row.content]));
}

/**
 * Bodies for one slice. Stored HTML is read only for rows whose body it is: a
 * row that names a retained source reads its HTML only when that source is
 * gone. Rows that already carry their HTML read nothing.
 */
async function loadSliceBodies(
  database: typeof db,
  rows: RequestedBody[],
  now: Date,
) {
  const unread = rows.filter((row) => row.content === undefined);
  const html = await storedHtmlOf(
    database,
    unread.filter((row) => !namesSource(row)),
  );
  const bodies = await loadReaderBodies(
    database,
    rows.map((row) => ({
      ...row,
      content: row.content ?? html.get(row.id) ?? "",
    })),
    now,
  );
  const sourceless = unread.filter(
    (row) => namesSource(row) && !bodies.get(row.id) && row.contentBytes > 0,
  );
  const fallback = await storedHtmlOf(database, sourceless);
  for (const row of sourceless)
    bodies.set(
      row.id,
      htmlBody({ ...row, content: fallback.get(row.id) ?? "" }),
    );
  return bodies;
}

/**
 * Loads bodies one slice at a time in request order and stops at the first
 * slice that crosses the response budget. Work stays bounded by the bytes
 * that ship, not by the number of ids asked for: a slice reads only the
 * stored HTML its sizes say can still fit.
 */
export async function loadCappedReaderBodies<T extends RequestedBody>(
  database: typeof db,
  rows: T[],
  now = new Date(),
) {
  const items: Array<{ row: T; body: ReaderBody | null }> = [];
  let bytes = 0;
  for (let offset = 0; offset < rows.length; offset += BODY_LOAD_SLICE) {
    const slice = rows.slice(offset, offset + BODY_LOAD_SLICE);
    const remaining = READER_BODY_RESPONSE_BUDGET_BYTES - bytes;
    const leadsResponse = offset === 0;
    const fitting = rowsKnownToFit(slice, remaining, leadsResponse);
    if (!fitting.length) break;
    // Slices are sequential by design: the next one loads only if this one fit.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const bodies = await loadSliceBodies(database, fitting, now);
    const entries = fitting.map((row) => ({
      row,
      body: bodies.get(row.id) ?? null,
    }));
    const capped = capReaderBodies(entries, remaining, leadsResponse);
    items.push(...capped.items);
    if (capped.omitted.length || fitting.length < slice.length) break;
    bytes += capped.items.reduce(
      (total, entry) => total + shippedBytes(entry.body),
      0,
    );
  }
  return { items, omitted: rows.slice(items.length) };
}

const requestedBodyColumns = {
  ...bodyHeadColumns,
  contentSnippet: feedItems.contentSnippet,
};

/**
 * The requested items the user owns, in request order, which decides the
 * bodies that fit under the response cap. A request of one slice reads its
 * bodies with its rows, in one statement. A larger one reads sizes first, so
 * the bodies that will not ship are never read.
 */
async function requestedBodyRows(
  database: typeof db,
  userId: string,
  ids: string[],
) {
  const rows: Array<RequestedBody & Pick<DatabaseFeedItem, "contentSnippet">> =
    await database
      .select(
        ids.length <= BODY_LOAD_SLICE
          ? { ...requestedBodyColumns, content: feedItems.content }
          : requestedBodyColumns,
      )
      .from(feedItems)
      .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
      .where(and(inArray(feedItems.id, ids), eq(feeds.userId, userId)));
  const position = new Map(ids.map((id, index) => [id, index]));
  return rows.sort((a, b) => position.get(a.id)! - position.get(b.id)!);
}

/** The reader bodies a user asked for by id, capped at the response budget. */
export async function loadRequestedReaderBodies(
  database: typeof db,
  userId: string,
  ids: string[],
  now = new Date(),
) {
  return loadCappedReaderBodies(
    database,
    await requestedBodyRows(database, userId, ids),
    now,
  );
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

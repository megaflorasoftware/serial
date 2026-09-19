import { and, eq, inArray } from "drizzle-orm";
import {
  parseAtUri,
  READER_BODY_RESPONSE_BUDGET_BYTES,
  readerBodyBytes,
  REFERENCE_REFRESH_INTERVAL_MS,
  referencedPublications,
  snapshotLookup,
} from "@serial/standard-site";
import { feedItems, feedOrigins, feeds } from "../db/schema";
import { loadDocumentSources, sourceKeyOf } from "../jetstream/document-source";
import {
  loadReferenceSnapshots,
  markReferenceSnapshotsRead,
  resolveSourceReferences,
  toReferenceSnapshot,
} from "../jetstream/reference-snapshots";
import {
  documentReferences,
  sourceReaderBody,
} from "../rss/documentObservation";
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

/** The client item without its body; lists and pages never carry one. */
export function toApplicationFeedItem(
  row: DatabaseFeedItem,
  platform: string,
  body: ReaderBody | null = null,
): ApplicationFeedItem {
  const { content, normalizedUrl, ...rest } = row;
  void content;
  void normalizedUrl;
  return { ...rest, platform, body } as ApplicationFeedItem;
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

/**
 * Snapshots for many sources in two reads: the records the bodies reference
 * directly, then the publications those documents name. Returns each source's
 * references in render order.
 */
async function snapshotsFor(
  database: typeof db,
  bodies: SourcedRow[],
  now: Date,
) {
  const direct = bodies.map(({ source, did }) =>
    documentReferences(source, did),
  );
  const snapshots = await loadReferenceSnapshots(database, direct.flat());
  const lookup = snapshotLookup(
    [...snapshots.values()].map(toReferenceSnapshot),
  );
  const complete = direct.map((references) => [
    ...references,
    ...referencedPublications(references, lookup),
  ]);
  const publications = complete.flat().filter((uri) => !snapshots.has(uri));
  for (const [uri, row] of await loadReferenceSnapshots(database, publications))
    snapshots.set(uri, row);
  await markReferenceSnapshotsRead(database, [...snapshots.keys()], now);
  return new Map(
    bodies.map(({ source }, index) => [
      source.uri,
      complete[index]!.map((uri) => snapshots.get(uri))
        .filter((row) => row !== undefined)
        .map(toReferenceSnapshot),
    ]),
  );
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
    (uri) => client.getRecord(uri, { deadline: Date.now() + 5_000 }),
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

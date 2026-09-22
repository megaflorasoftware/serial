import { and, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  BLUESKY_PROFILE_COLLECTION,
  isDid,
  isReferenceSnapshotStale,
  MAX_REFERENCE_HOPS,
  MissingPublicRecordError,
  nextReferenceHop,
  parseAtUri,
  PublicRecordVersionUnavailableError,
  REFERENCE_UNREAD_RETENTION_MS,
  snapshotLookup,
  SOCIAL_POST_COLLECTIONS,
  STANDARD_SITE_COLLECTIONS,
  validatePublicRecord,
} from "@serial/standard-site";
import { documentReferences } from "../rss/documentObservation";
import { atprotoReferenceSnapshots } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { UnsupportedDidError } from "../auth/atproto/did-resolver";
import { captureRecordValue } from "./document-source";
import type { DocumentSource, ReferenceSnapshot } from "@serial/standard-site";
import type { FeedDatabase } from "../feeds/origins";
import type { PublicationClient } from "../rss/atprotoClient";
import type { db } from "../db";
import { workerPool } from "~/lib/workerPool";

type SnapshotRow = typeof atprotoReferenceSnapshots.$inferSelect;

/** Collections whose records the reader can present. Everything else is unsupported. */
const SUPPORTED_COLLECTIONS = new Set<string>([
  STANDARD_SITE_COLLECTIONS.document,
  STANDARD_SITE_COLLECTIONS.publication,
  "blog.pckt.gallery",
  SOCIAL_POST_COLLECTIONS.bluesky,
  SOCIAL_POST_COLLECTIONS.pckt,
  BLUESKY_PROFILE_COLLECTION,
]);

/** Once a day per row is enough to keep a read snapshot out of the sweep. */
const READ_MARK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function toReferenceSnapshot(row: SnapshotRow): ReferenceSnapshot {
  return {
    uri: row.uri,
    cid: row.cid,
    outcome: row.outcome,
    record: row.record,
    resolvedAt: row.resolvedAt.toISOString(),
  };
}

export async function loadReferenceSnapshots(
  database: FeedDatabase,
  uris: readonly string[],
) {
  if (!uris.length) return new Map<string, SnapshotRow>();
  const rows = await database
    .select()
    .from(atprotoReferenceSnapshots)
    .where(inArray(atprotoReferenceSnapshots.uri, [...new Set(uris)]));
  return new Map(rows.map((row) => [row.uri, row]));
}

/** Bumps read times for served snapshots, at most once per day per row. */
export async function markReferenceSnapshotsRead(
  database: typeof db,
  uris: readonly string[],
  now: Date,
) {
  if (!uris.length) return;
  const threshold = new Date(now.getTime() - READ_MARK_INTERVAL_MS);
  await runDatabaseWrite(database, () =>
    database
      .update(atprotoReferenceSnapshots)
      .set({ readAt: now })
      .where(
        and(
          inArray(atprotoReferenceSnapshots.uri, [...new Set(uris)]),
          or(
            isNull(atprotoReferenceSnapshots.readAt),
            lt(atprotoReferenceSnapshots.readAt, threshold),
          ),
        ),
      ),
  );
}

/** Rows nobody has read for the retention window are dropped, however fresh. */
export async function sweepReferenceSnapshots(database: typeof db, now: Date) {
  const threshold = new Date(now.getTime() - REFERENCE_UNREAD_RETENTION_MS);
  await runDatabaseWrite(database, () =>
    database
      .delete(atprotoReferenceSnapshots)
      .where(lt(atprotoReferenceSnapshots.readAt, threshold)),
  );
}

/**
 * How references are read: a record by its at-uri, or a DID document by its
 * DID. Both land in the same table, a DID document under its DID with no cid.
 */
export type ReferenceReaders = {
  record: (uri: string) => Promise<unknown>;
  didDocument: (did: string) => Promise<unknown>;
};

/** Readers over a publication client, sharing its per-refresh caches and one deadline. */
export function referenceReaders(
  client: Pick<PublicationClient, "getRecord" | "getDidDocument">,
  deadlineMs: number,
): ReferenceReaders {
  return {
    record: (uri) =>
      client.getRecord(uri, { deadline: Date.now() + deadlineMs }),
    didDocument: (did) =>
      client.getDidDocument(did, { deadline: Date.now() + deadlineMs }),
  };
}

type Resolution = Pick<SnapshotRow, "cid" | "outcome" | "record">;

/** A gone DID, or a directory that says so, is missing; anything else is a retry. */
function isMissingDidDocument(error: unknown) {
  const status =
    typeof error === "object" && error !== null
      ? ((error as { status?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode)
      : undefined;
  return status === 404 || status === 410;
}

async function resolveDidDocument(
  did: string,
  read: ReferenceReaders["didDocument"],
): Promise<Resolution> {
  try {
    const document = await read(did);
    if (!document || typeof document !== "object") throw new TypeError();
    return {
      cid: null,
      outcome: "resolved",
      record: captureRecordValue(document).text,
    };
  } catch (error) {
    if (isMissingDidDocument(error))
      return { cid: null, outcome: "missing", record: null };
    if (
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      error instanceof UnsupportedDidError
    )
      return { cid: null, outcome: "unsupported", record: null };
    return { cid: null, outcome: "unavailable", record: null };
  }
}

/** One lookup mapped onto the four outcomes. Network and budget failures are unavailable. */
async function resolveReference(
  uri: string,
  readers: ReferenceReaders,
): Promise<Resolution> {
  if (isDid(uri)) return resolveDidDocument(uri, readers.didDocument);
  const parts = parseAtUri(uri);
  if (!parts || !SUPPORTED_COLLECTIONS.has(parts.collection))
    return { cid: null, outcome: "unsupported", record: null };
  try {
    const record = validatePublicRecord({ uri }, await readers.record(uri));
    return {
      cid: record.cid,
      outcome: "resolved",
      record: captureRecordValue(record.value).text,
    };
  } catch (error) {
    if (
      error instanceof MissingPublicRecordError ||
      error instanceof PublicRecordVersionUnavailableError
    )
      return { cid: null, outcome: "missing", record: null };
    if (error instanceof SyntaxError || error instanceof TypeError)
      return { cid: null, outcome: "unsupported", record: null };
    return { cid: null, outcome: "unavailable", record: null };
  }
}

function fresh(row: SnapshotRow | undefined, now: Date, reuseMs: number) {
  if (!row) return false;
  if (row.outcome === "resolved")
    return now.getTime() - row.resolvedAt.getTime() < reuseMs;
  return !isReferenceSnapshotStale(toReferenceSnapshot(row), now.getTime());
}

/**
 * Resolves the URIs whose snapshot is absent or stale and stores the result.
 * A lookup that returns the same CID keeps the stored record and only moves
 * the time forward. Returns every requested snapshot, resolved or not.
 */
export async function refreshReferenceSnapshots(
  database: typeof db,
  uris: readonly string[],
  readers: ReferenceReaders,
  options: { now: Date; reuseMs: number; concurrency?: number },
) {
  const existing = await loadReferenceSnapshots(database, uris);
  const due = [...new Set(uris)].filter(
    (uri) => !fresh(existing.get(uri), options.now, options.reuseMs),
  );
  const resolved = new Map<string, Resolution>();
  for await (const unused of workerPool(
    due,
    options.concurrency ?? 4,
    async (uri) => {
      resolved.set(uri, await resolveReference(uri, readers));
    },
  )) {
    void unused;
  }
  const rows = due.map((uri) => {
    const result = resolved.get(uri)!;
    const previous = existing.get(uri);
    // A DID document has no cid, so a fresh read always replaces it.
    const unchanged =
      result.outcome === "resolved" &&
      result.cid !== null &&
      previous?.outcome === "resolved" &&
      previous.cid === result.cid;
    return {
      uri,
      cid: result.cid,
      outcome: result.outcome,
      record: unchanged ? previous.record : result.record,
      resolvedAt: options.now,
      readAt: previous?.readAt ?? options.now,
    };
  });
  for (let offset = 0; offset < rows.length; offset += 50) {
    // Bound each statement; snapshots are independent rows.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await runDatabaseWrite(database, () =>
      database
        .insert(atprotoReferenceSnapshots)
        .values(rows.slice(offset, offset + 50))
        .onConflictDoUpdate({
          target: atprotoReferenceSnapshots.uri,
          set: {
            cid: sql`excluded.cid`,
            outcome: sql`excluded.outcome`,
            record: sql`excluded.record`,
            resolvedAt: sql`excluded.resolved_at`,
          },
        }),
    );
  }
  for (const row of rows) existing.set(row.uri, row);
  return existing;
}

/**
 * The snapshots a source renders, in render order. Records referenced by
 * cards name further records (a document its publication, a post its author
 * and quote), which are known only once the first are in hand, so the lookup
 * runs hop by hop over the same rows, a bounded number of times.
 */
export async function sourceReferences(
  database: FeedDatabase,
  source: DocumentSource,
  did: string,
  lookup: (uris: string[]) => Promise<Map<string, SnapshotRow>>,
): Promise<ReferenceSnapshot[]> {
  const order = documentReferences(source, did);
  const snapshots = await lookup(order);
  let frontier = order;
  for (let hop = 0; hop < MAX_REFERENCE_HOPS && frontier.length; hop += 1) {
    const next = nextReferenceHop(
      frontier,
      new Set(order),
      snapshotLookup([...snapshots.values()].map(toReferenceSnapshot)),
    );
    // Each hop depends on the records the previous one resolved.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    for (const [uri, row] of await lookup(next)) snapshots.set(uri, row);
    order.push(...next);
    frontier = next;
  }
  return order
    .map((uri) => snapshots.get(uri))
    .filter((row) => row !== undefined)
    .map(toReferenceSnapshot);
}

/** Import and open-time refresh: resolve what is absent or stale, then read in render order. */
export async function resolveSourceReferences(
  database: typeof db,
  source: DocumentSource,
  did: string,
  readers: ReferenceReaders,
  options: { now: Date; reuseMs: number },
): Promise<ReferenceSnapshot[]> {
  return sourceReferences(database, source, did, (uris) =>
    refreshReferenceSnapshots(database, uris, readers, options),
  );
}

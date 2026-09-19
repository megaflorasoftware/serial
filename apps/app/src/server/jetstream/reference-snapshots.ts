import { and, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  isReferenceSnapshotStale,
  MissingPublicRecordError,
  PublicRecordVersionUnavailableError,
  parseAtUri,
  REFERENCE_IMPORT_REUSE_MS,
  REFERENCE_UNREAD_RETENTION_MS,
  STANDARD_SITE_COLLECTIONS,
  validatePublicRecord,
} from "@serial/standard-site";
import type { DocumentSource, ReferenceSnapshot } from "@serial/standard-site";
import { documentReferences, snapshotLookup } from "../rss/documentObservation";
import { atprotoReferenceSnapshots } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { captureRecordValue } from "./document-source";
import type { FeedDatabase } from "../feeds/origins";
import type { db } from "../db";
import { workerPool } from "~/lib/workerPool";

type SnapshotRow = typeof atprotoReferenceSnapshots.$inferSelect;

/** Collections whose records the reader can present. Everything else is unsupported. */
const SUPPORTED_COLLECTIONS = new Set<string>([
  STANDARD_SITE_COLLECTIONS.document,
  STANDARD_SITE_COLLECTIONS.publication,
  "blog.pckt.gallery",
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

/** Rows nobody has read for the retention window are dropped. */
export async function sweepReferenceSnapshots(database: typeof db, now: Date) {
  const threshold = new Date(now.getTime() - REFERENCE_UNREAD_RETENTION_MS);
  await runDatabaseWrite(database, () =>
    database
      .delete(atprotoReferenceSnapshots)
      .where(
        and(
          lt(atprotoReferenceSnapshots.resolvedAt, threshold),
          or(
            isNull(atprotoReferenceSnapshots.readAt),
            lt(atprotoReferenceSnapshots.readAt, threshold),
          ),
        ),
      ),
  );
}

export type ReferenceReader = (uri: string) => Promise<unknown>;

type Resolution = Pick<SnapshotRow, "cid" | "outcome" | "record">;

/** One lookup mapped onto the four outcomes. Network and budget failures are unavailable. */
async function resolveReference(
  uri: string,
  readRecord: ReferenceReader,
): Promise<Resolution> {
  const parts = parseAtUri(uri);
  if (!parts || !SUPPORTED_COLLECTIONS.has(parts.collection))
    return { cid: null, outcome: "unsupported", record: null };
  try {
    const record = validatePublicRecord({ uri }, await readRecord(uri));
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
  readRecord: ReferenceReader,
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
      resolved.set(uri, await resolveReference(uri, readRecord));
    },
  )) {
    void unused;
  }
  const rows = due.map((uri) => {
    const result = resolved.get(uri)!;
    const previous = existing.get(uri);
    const unchanged =
      result.outcome === "resolved" &&
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

/** Import reuse window: a day for resolved records, outcome rules otherwise. */
export const IMPORT_REUSE_MS = REFERENCE_IMPORT_REUSE_MS;

/**
 * The snapshots a source renders, in render order, refreshing rows older
 * than the reuse window. Documents referenced by cards name their
 * publications, which resolve in a second pass once the documents are known.
 */
export async function resolveSourceReferences(
  database: typeof db,
  source: DocumentSource,
  did: string,
  readRecord: ReferenceReader,
  options: { now: Date; reuseMs: number },
): Promise<ReferenceSnapshot[]> {
  const direct = documentReferences(source, did, () => undefined);
  const snapshots = await refreshReferenceSnapshots(
    database,
    direct,
    readRecord,
    options,
  );
  const lookup = snapshotLookup(
    [...snapshots.values()].map(toReferenceSnapshot),
  );
  const references = documentReferences(source, did, lookup);
  const publications = references.filter((uri) => !snapshots.has(uri));
  for (const [uri, row] of await refreshReferenceSnapshots(
    database,
    publications,
    readRecord,
    options,
  ))
    snapshots.set(uri, row);
  return references
    .map((uri) => snapshots.get(uri))
    .filter((row) => row !== undefined)
    .map(toReferenceSnapshot);
}

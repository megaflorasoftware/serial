import { and, asc, count, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  buildBlueskyCdnImageUrl,
  listedRecordSchema,
  parseDocumentRecord,
  parsePublicationRecord,
  REFERENCE_IMPORT_REUSE_MS,
} from "@serial/standard-site";
import {
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  sweepableOrigin,
} from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { nextRetryAt } from "../publication-sync/retry";
import { createPublicationClient } from "../rss/atprotoClient";
import {
  deriveDocumentBody,
  documentObservation,
  fetchDocumentBlobs,
  retainedSource,
  sourceReaderBody,
} from "../rss/documentObservation";
import { enrichObservationImages } from "../rss/observationImages";
import { writeObservedItems } from "../rss/writeItems";
import {
  applyOriginMetadata,
  recomputeFeedPlatform,
} from "../rss/originMetadata";
import { readFeedHttp } from "../rss/feedHttp";
import {
  referenceReaders,
  resolveSourceReferences,
} from "./reference-snapshots";
import {
  captureRecordValue,
  isRecordOverBudget,
  OversizedDocumentSourceError,
  pruneDocumentSources,
  readStagedRecord,
  recordContentType,
  stageDocumentSource,
  storeDocumentBlobs,
} from "./document-source";
import { CheckpointHostError } from "./protocol";
import {
  eligible,
  loadOrigin,
  nowFor,
  pauseOriginStream,
  planFor,
} from "./store";
import { createStreamReporter } from "./report";
import type { FetchedBlob } from "./document-source";
import type { StreamDatabase, StreamOrigin, StreamSettings } from "./store";
import type {
  ApplicationFeedItem,
  DOCUMENT_LEDGER_REASONS,
} from "../db/schema";
import type { PublicationClient } from "../rss/atprotoClient";
import type { PlanConfig } from "../subscriptions/plans";
import type { FeedDatabase } from "../feeds/origins";
import { workerPool } from "~/lib/workerPool";

export type CommittedUpdate = {
  userId: string;
  feedId: number;
  items: ApplicationFeedItem[];
  removedItemIds: string[];
  metadataChanged?: boolean;
};
export type ProcessingOptions = {
  manual?: boolean;
  /** Keep processing pages until nothing is pending; a user is waiting on the result. */
  drain?: boolean;
  signal?: AbortSignal;
  workOwner?: string;
  client?: PublicationClient;
  readPage?: typeof readFeedHttp;
  publish?: (update: CommittedUpdate) => Promise<void>;
};

/**
 * When the origin's staged documents are next due, read from the rows left:
 * the first entry of the due index, where a document never tried sorts ahead
 * of every retry time and counts as due at once. NULL when none is staged.
 */
function nextDocumentDue(originId: number) {
  return sql`(select coalesce(${feedOriginAtprotoDocuments.retryAt}, 0) from ${feedOriginAtprotoDocuments} where ${feedOriginAtprotoDocuments.originId} = ${originId} and ${feedOriginAtprotoDocuments.status} = 'retry' order by ${feedOriginAtprotoDocuments.retryAt} limit 1)`;
}

/**
 * Restates on the origin when its staged documents are next due, after a pass
 * changed them. One seek, and a write only when the time moved. A document
 * staged meanwhile is counted: this is one statement, and staging marks the
 * origin in the transaction that stages.
 */
async function restateDocumentsDue(database: StreamDatabase, originId: number) {
  const next = nextDocumentDue(originId);
  await runDatabaseWrite(database, () =>
    database
      .update(feedOriginAtproto)
      .set({ stagedDueAt: next })
      .where(
        and(
          eq(feedOriginAtproto.originId, originId),
          sql`${feedOriginAtproto.stagedDueAt} is not ${next}`,
        ),
      ),
  );
}

/**
 * An origin whose Publication is gone or unreadable asks for no sweep. Its
 * staged documents wait for the Publication, and a record that does not parse
 * stops waiting to be applied. The Publication's next event marks the origin
 * again, and that pass restates when the documents are due. Nothing is
 * written when such an event arrived after the row was read.
 */
async function shelveOrigin(
  database: StreamDatabase,
  row: Pick<StreamOrigin, "origin" | "atproto">,
) {
  const { stagedDueAt, publicationDirty, publicationSeq } = row.atproto;
  if (stagedDueAt === null && !publicationDirty) return;
  await runDatabaseWrite(database, () =>
    database
      .update(feedOriginAtproto)
      .set({ stagedDueAt: null, publicationDirty: false })
      .where(
        and(
          eq(feedOriginAtproto.originId, row.origin.id),
          publicationSeq === null
            ? isNull(feedOriginAtproto.publicationSeq)
            : eq(feedOriginAtproto.publicationSeq, publicationSeq),
        ),
      ),
  );
}

/**
 * An origin that cannot be processed leaves live mode the way it does when an
 * event arrives for it, so its staged work stops asking for a sweep.
 */
async function pauseUnlessEligible(
  database: StreamDatabase,
  originId: number,
  plan: PlanConfig,
  settings: StreamSettings,
  options: Pick<ProcessingOptions, "manual">,
) {
  await runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
        const latest = await loadOrigin(tx, originId);
        if (latest && !eligible(latest, plan, settings, options.manual))
          await pauseOriginStream(tx, latest, nowFor(settings));
      },
      { behavior: "immediate" },
    ),
  );
}

export async function processOriginDocuments(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
  options: ProcessingOptions = {},
) {
  const row = await loadOrigin(database, originId);
  if (
    row?.atproto.streamService &&
    row.atproto.streamService !== settings.service
  )
    throw new CheckpointHostError();
  if (
    !row ||
    !row.atproto.initialized ||
    row.atproto.streamMode !== "live" ||
    !row.atproto.repositoryActive
  )
    return;
  const plan = await planFor(row, settings);
  if (!eligible(row, plan, settings, options.manual)) {
    await pauseUnlessEligible(database, originId, plan, settings, options);
    return;
  }
  const report = createStreamReporter(settings.service);
  const client = options.client ?? createPublicationClient();
  let publication = parsePublicationRecord(row.atproto.publicationRecord);
  // The author deleted or invalidated the Publication.
  if (!publication && row.atproto.publicationSeq)
    return shelveOrigin(database, row);
  if (!publication)
    publication = parsePublicationRecord(
      await client.getRecord(row.origin.locator),
    );
  if (!publication) {
    await shelveOrigin(database, row);
    throw new Error("Invalid Publication record");
  }
  if (row.atproto.publicationDirty) {
    const changed = await runDatabaseWrite(database, () =>
      database.transaction(
        async (tx) => {
          const latest = await loadOrigin(tx, originId);
          if (
            !latest ||
            latest.account.role !== row.account.role ||
            options.signal?.aborted ||
            (options.workOwner !== undefined &&
              latest.atproto.workOwner !== options.workOwner) ||
            !latest.atproto.repositoryActive ||
            latest.atproto.accountSeq !== row.atproto.accountSeq ||
            !eligible(latest, plan, settings, options.manual) ||
            latest.atproto.publicationSeq !== row.atproto.publicationSeq
          )
            return false;
          const result = await applyOriginMetadata(tx, latest, {
            name: publication.value.name,
            siteUrl: publication.value.url,
            description: publication.value.description,
            imageUrl: publication.value.icon
              ? buildBlueskyCdnImageUrl(
                  row.atproto.publicationDid,
                  publication.value.icon.ref.$link,
                  "avatar",
                )
              : null,
          });
          await tx
            .update(feedOriginAtproto)
            .set({ publicationDirty: false })
            .where(eq(feedOriginAtproto.originId, originId));
          return result;
        },
        { behavior: "immediate" },
      ),
    );
    if (changed)
      await options.publish?.({
        userId: row.account.id,
        feedId: row.feed.id,
        items: [],
        removedItemIds: [],
        metadataChanged: true,
      });
  }
  const pending = await database
    .select()
    .from(feedOriginAtprotoDocuments)
    .where(pendingDocuments(originId, settings))
    // Fresh work first, newest document first, so a bootstrap surfaces recent items.
    .orderBy(
      asc(feedOriginAtprotoDocuments.retryAt),
      desc(feedOriginAtprotoDocuments.uri),
    )
    .limit(25);
  let imageRequests = 0;
  const readPage: typeof readFeedHttp = async (...args) => {
    if (imageRequests++ >= 8) throw new Error("Optional image batch complete");
    return (options.readPage ?? readFeedHttp)(...args);
  };
  const committed = new Map<string, ApplicationFeedItem>();
  const removed = new Set<string>();
  const now = nowFor(settings);
  const did = row.atproto.publicationDid;
  for await (const unused of workerPool(pending, 4, async (entry) => {
    const key = { originId, uri: entry.uri, cid: entry.cid };
    const identity = and(
      eq(feedOriginAtprotoDocuments.originId, originId),
      eq(feedOriginAtprotoDocuments.uri, entry.uri),
      entry.eventSeq === null
        ? isNull(feedOriginAtprotoDocuments.eventSeq)
        : eq(feedOriginAtprotoDocuments.eventSeq, entry.eventSeq),
      eq(feedOriginAtprotoDocuments.cid, entry.cid),
      eq(feedOriginAtprotoDocuments.status, "retry"),
    );
    /** The version leaves the pending set for good; only a newer one is tried. */
    const retire = (reason: (typeof DOCUMENT_LEDGER_REASONS)[number]) =>
      runDatabaseWrite(database, () =>
        database.transaction(async (tx) => {
          const marked = await tx
            .update(feedOriginAtprotoDocuments)
            .set({ status: "invalid", reason })
            .where(identity)
            .returning({ uri: feedOriginAtprotoDocuments.uri });
          // A version staged meanwhile owns the row now; leave its source alone.
          if (!marked.length) return;
          // The readable source stays; the failed version is not retained.
          await pruneDocumentSources(tx, originId, [
            { uri: entry.uri, keep: [entry.bodyCid] },
          ]);
        }),
      );
    const invalidate = async (
      reason: (typeof DOCUMENT_LEDGER_REASONS)[number],
      error: Error,
    ) => {
      await retire(reason);
      report(error, "document-validation");
    };
    try {
      // A staged record read is one narrow row; the ledger never carries it.
      // A missing row (older ledger entries, a pruned version) reads the
      // record itself, which the budget then bounds like staging does.
      const captured =
        (await readStagedRecord(database, key)) ??
        captureRecordValue(
          listedRecordSchema.parse(
            await client.getRecord(entry.uri, { cid: entry.cid }),
          ).value,
        );
      if (isRecordOverBudget(captured.text)) {
        await invalidate("oversized", new OversizedDocumentSourceError());
        return;
      }
      const document = parseDocumentRecord({
        uri: entry.uri,
        cid: entry.cid,
        value: captured.value,
      });
      if (!document) {
        await invalidate("invalid", new Error("Invalid document"));
        return;
      }
      let blobs: FetchedBlob[];
      try {
        blobs = await fetchDocumentBlobs(document, captured.text, did, client);
      } catch (error) {
        if (!(error instanceof OversizedDocumentSourceError)) throw error;
        await invalidate("oversized", error);
        return;
      }
      const source = retainedSource(key, captured.text, blobs);
      const references = await resolveSourceReferences(
        database,
        source,
        did,
        // Lookup budgets are wall-clock; `now` only stamps stored rows.
        referenceReaders(client, 5_000),
        { now, reuseMs: REFERENCE_IMPORT_REUSE_MS },
      );
      const body = sourceReaderBody(source, references);
      const outcome = deriveDocumentBody(document, body, did);
      // A rejected or absent body writes the item anyway; the last readable body stays.
      const observation = documentObservation(document, publication, did, {
        outcome,
        cid: entry.cid,
        readableCid: entry.bodyCid,
      });
      if (outcome.kind === "rejected")
        report(new Error("Document source did not derive"), "document-adapter");
      const incoming = await enrichObservationImages([observation], readPage);
      const currentPlan = await planFor(row, settings);
      const written = await writeObservedItems(database, row.feed, incoming, {
        canWrite: async (tx: FeedDatabase) => {
          const latest = await loadOrigin(tx, originId);
          if (
            !latest ||
            latest.account.role !== row.account.role ||
            options.signal?.aborted ||
            (options.workOwner !== undefined &&
              latest.atproto.workOwner !== options.workOwner) ||
            !latest.atproto.repositoryActive ||
            latest.atproto.accountSeq !== row.atproto.accountSeq ||
            !eligible(latest, currentPlan, settings, options.manual) ||
            latest.atproto.streamMode !== "live" ||
            latest.atproto.publicationSeq !== row.atproto.publicationSeq ||
            latest.atproto.repositorySeq !== row.atproto.repositorySeq
          )
            return false;
          return Boolean(
            await tx
              .select({ uri: feedOriginAtprotoDocuments.uri })
              .from(feedOriginAtprotoDocuments)
              .where(identity)
              .get(),
          );
        },
        didWrite: async (tx) => {
          const readable = outcome.kind === "source";
          // Source and blobs become readable in the same transaction as the item.
          if (readable) {
            await stageDocumentSource(tx, key, captured.text, now);
            await storeDocumentBlobs(tx, key, blobs);
          }
          const bodyCid = readable ? entry.cid : entry.bodyCid;
          await tx
            .update(feedOriginAtprotoDocuments)
            .set({
              status: "ready",
              bodyCid,
              bodyContentType: readable
                ? recordContentType(captured.value)
                : entry.bodyContentType,
              reason: outcome.kind === "rejected" ? "adapter" : null,
              attempts: 0,
              retryAt: null,
            })
            .where(identity);
          await pruneDocumentSources(tx, originId, [
            { uri: entry.uri, keep: [bodyCid] },
          ]);
        },
      });
      for (const id of written.removedItemIds) {
        removed.add(id);
        committed.delete(id);
      }
      for (const item of written.items)
        if (!removed.has(item.id)) committed.set(item.id, item);
    } catch (error) {
      report(error, "document-processing");
      const attempts = entry.attempts + 1;
      const retryAt = nextRetryAt(attempts, now);
      // Once its retries are spent, the version waits for its publisher's next edit.
      if (!retryAt) await retire("failed");
      else
        await runDatabaseWrite(database, () =>
          database
            .update(feedOriginAtprotoDocuments)
            .set({ attempts, retryAt })
            .where(identity),
        );
    }
  })) {
    void unused;
  }
  // Nothing staged before and nothing found leaves nothing to restate, unless
  // this pass applied a Publication that documents may have been shelved for.
  if (
    pending.length ||
    row.atproto.stagedDueAt !== null ||
    row.atproto.publicationDirty
  )
    await restateDocumentsDue(database, originId);
  // The readable versions' content types decide the Feed's platform; a batch
  // that wrote nothing readable cannot have changed it.
  const platformChanged = committed.size
    ? await runDatabaseWrite(database, () =>
        database.transaction(
          async (tx) => {
            const latest = await loadOrigin(tx, originId);
            return latest
              ? recomputeFeedPlatform(tx, latest.feed, originId)
              : false;
          },
          { behavior: "immediate" },
        ),
      )
    : false;
  if (committed.size || removed.size)
    await options.publish?.({
      userId: row.account.id,
      feedId: row.feed.id,
      items: [...committed.values()],
      removedItemIds: [...removed],
      ...(platformChanged ? { metadataChanged: true } : {}),
    });
}

/**
 * A fetch a user is waiting on keeps processing until nothing is pending, so
 * the items it reports are complete. Every other pass stays bounded to one
 * page so one large Publication cannot hold the worker or a job. The caller's
 * signal bounds the whole drain; a page that only produced retries ends it.
 */
export async function drainOriginDocuments(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
  options: ProcessingOptions = {},
) {
  // The first page always runs: it also applies a changed Publication record.
  let before = options.drain
    ? await pendingDocumentCount(database, originId, settings)
    : 0;
  await processOriginDocuments(database, originId, settings, options);
  while (options.drain && before > 0) {
    // Each page depends on the writes of the previous one.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const after = await pendingDocumentCount(database, originId, settings);
    if (after === 0 || after >= before) return;
    before = after;
    options.signal?.throwIfAborted();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await processOriginDocuments(database, originId, settings, options);
  }
}

export async function pendingDocumentCount(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
) {
  const row = await database
    .select({ count: count() })
    .from(feedOriginAtprotoDocuments)
    .where(pendingDocuments(originId, settings))
    .get();
  return row?.count ?? 0;
}

/** The condition both pending-work indexes keep, stated the way they state it. */
const sweepable = sweepableOrigin(feedOriginAtproto);

/**
 * Origins the sweep may process that hold a staged document now due, or a
 * Publication record to apply. Each half reads only its partial index, one
 * entry per origin with due work, so the sweep costs the same however many
 * documents are staged, in backoff, or held by origins it may not process.
 * An origin whose Feed or reader no longer qualifies is found once:
 * processing it pauses it.
 */
export async function originsWithDueWork(database: StreamDatabase, now: Date) {
  // The halves are neither merged nor ordered nor paged by origin in SQL: any
  // of those has SQLite walk every origin in key order instead of the entries
  // that are due. An origin with both kinds of work is listed twice.
  const due = await database.all<{ originId: number }>(sql`
    select ${feedOriginAtproto.originId} as "originId"
    from ${feedOriginAtproto}
    where ${lte(feedOriginAtproto.stagedDueAt, now)}
      and ${sweepable}
    union all
    select ${feedOriginAtproto.originId}
    from ${feedOriginAtproto}
    where ${feedOriginAtproto.publicationDirty} = 1
      and ${sweepable}
  `);
  return [...new Set(due.map((origin) => origin.originId))];
}

/**
 * Drains one page of staged work for each origin that has some due. Only the
 * instance holding the stream lease sweeps, so instances do not repeat each
 * other's work. Each origin is visited once per sweep, so one that stays due
 * cannot hold the others back.
 */
export async function drainDueOrigins(
  database: StreamDatabase,
  settings: StreamSettings,
  options: Pick<ProcessingOptions, "client" | "readPage" | "publish"> & {
    holdsLease: () => boolean;
    signal: AbortSignal;
    report?: (error: unknown) => void;
  },
) {
  const { holdsLease, report, ...processing } = options;
  const sweeps = () => !processing.signal.aborted && holdsLease();
  if (!sweeps()) return;
  const originIds = await originsWithDueWork(database, nowFor(settings));
  for await (const unused of workerPool(originIds, 4, async (originId) => {
    if (!sweeps()) return;
    try {
      await processOriginDocuments(database, originId, settings, processing);
    } catch (error) {
      if (!processing.signal.aborted) report?.(error);
    }
  })) {
    void unused;
  }
}

/** A staged version whose retry time, if any, has passed. */
function retryIsDue(now: Date) {
  return and(
    sql`${feedOriginAtprotoDocuments.status} = 'retry'`,
    or(
      isNull(feedOriginAtprotoDocuments.retryAt),
      lte(feedOriginAtprotoDocuments.retryAt, now),
    ),
  )!;
}

/** One origin's staged versions whose retry is due. */
function pendingDocuments(originId: number, settings: StreamSettings) {
  return and(
    eq(feedOriginAtprotoDocuments.originId, originId),
    retryIsDue(nowFor(settings)),
  );
}

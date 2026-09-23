import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import {
  buildBlueskyCdnImageUrl,
  listedRecordSchema,
  parseDocumentRecord,
  parsePublicationRecord,
  REFERENCE_IMPORT_REUSE_MS,
} from "@serial/standard-site";
import { feedOriginAtproto, feedOriginAtprotoDocuments } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
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
import { applyOriginMetadata } from "../rss/originMetadata";
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
  stageDocumentSource,
  storeDocumentBlobs,
} from "./document-source";
import { CheckpointHostError } from "./protocol";
import { eligible, loadOrigin, nowFor, planFor } from "./store";
import { createStreamReporter } from "./report";
import type { FetchedBlob } from "./document-source";
import type { StreamDatabase, StreamSettings } from "./store";
import type {
  ApplicationFeedItem,
  DOCUMENT_LEDGER_REASONS,
} from "../db/schema";
import type { PublicationClient } from "../rss/atprotoClient";
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
  signal?: AbortSignal;
  workOwner?: string;
  client?: PublicationClient;
  readPage?: typeof readFeedHttp;
  publish?: (update: CommittedUpdate) => Promise<void>;
};

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
  if (!eligible(row, plan, settings, options.manual)) return;
  const report = createStreamReporter(settings.service);
  const client = options.client ?? createPublicationClient();
  let publication = parsePublicationRecord(row.atproto.publicationRecord);
  if (!publication && row.atproto.publicationSeq) return; // Author deleted or invalidated the Publication.
  if (!publication)
    publication = parsePublicationRecord(
      await client.getRecord(row.origin.locator),
    );
  if (!publication) throw new Error("Invalid Publication record");
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
    .where(
      and(
        eq(feedOriginAtprotoDocuments.originId, originId),
        eq(feedOriginAtprotoDocuments.status, "retry"),
        or(
          isNull(feedOriginAtprotoDocuments.retryAt),
          lte(feedOriginAtprotoDocuments.retryAt, nowFor(settings)),
        ),
      ),
    )
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
    const invalidate = async (
      reason: (typeof DOCUMENT_LEDGER_REASONS)[number],
      error: Error,
    ) => {
      await runDatabaseWrite(database, () =>
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
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtprotoDocuments)
          .set({
            attempts: entry.attempts + 1,
            retryAt: new Date(
              now.getTime() +
                Math.min(3_600_000, 5000 * 2 ** Math.min(entry.attempts, 10)),
            ),
          })
          .where(identity),
      );
    }
  })) {
    void unused;
  }
  if (committed.size || removed.size)
    await options.publish?.({
      userId: row.account.id,
      feedId: row.feed.id,
      items: [...committed.values()],
      removedItemIds: [...removed],
    });
}

import { and, asc, eq, isNull } from "drizzle-orm";
import {
  newPublicationSyncRequest,
  nextPublicationSyncAttempt,
} from "./requests";
import { backfillPublicationOrigins } from "./backfill";
import { planPublicationSync } from "./plan";
import { saveSubscriptionObservation } from "./observation";
import {
  createPublicSubscriptionStore,
  MAX_SUBSCRIPTION_RECORDS,
} from "./record-store";
import {
  assertSubscriptionSyncCurrent,
  claimSubscriptionSync,
  renewSubscriptionSync,
  SubscriptionSyncChangedError,
  syncClaimCondition,
} from "./state";
import type {
  SubscriptionRecord,
  SubscriptionRecordStore,
} from "./record-store";
import type { db as Database } from "~/server/db";
import type { DatabaseSubscriptionMirror } from "~/server/db/schema";
import type {
  PublicationSyncProgress,
  PublicationSyncResult,
} from "~/lib/auth/publication-sync";
import type { PreparedFeedImport } from "~/server/feeds/imports";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";
import {
  atprotoConnections,
  feedOrigins,
  atprotoSubscriptionMirror as mirror,
} from "~/server/db/schema";
import { commitFeedImport, prepareFeedImport } from "~/server/feeds/imports";
import {
  FeedImportDeferredError,
  FeedImportSkippedError,
} from "~/server/feeds/importErrors";
import { deleteUserFeeds } from "~/server/feeds/delete";
import {
  getActiveFeedCount,
  getFeedsActivationBudget,
} from "~/server/subscriptions/helpers";
import { logError } from "~/server/logger";
import {
  organizationInvalidationSummary,
  publishReconciliationInvalidation,
} from "~/server/reconciliation/invalidation";

function groupByPublication<T extends { publicationUri: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.publicationUri) ?? [];
    group.push(row);
    grouped.set(row.publicationUri, group);
  }
  return grouped;
}
async function resolveImportedFeed(userId: string, publicationUri: string) {
  const { resolvePublicationFeed } =
    await import("~/server/feeds/resolveSelection");
  const [details] = await resolvePublicationFeed(userId, publicationUri);
  if (!details) throw new Error("Unable to resolve publication");
  return details;
}

export async function syncPublicationSubscriptions(input: {
  database: typeof Database;
  userId: string;
  runId?: string;
  onProgress?: (progress: PublicationSyncProgress) => Promise<void>;
  dependencies?: {
    backfill?: typeof backfillPublicationOrigins;
    store?: SubscriptionRecordStore;
    resolveFeed?: typeof resolveImportedFeed;
    activationBudget?: typeof getFeedsActivationBudget;
    invalidate?: typeof publishReconciliationInvalidation;
  };
}): Promise<PublicationSyncResult> {
  const { database, userId } = input;
  const counts = emptyPublicationSyncCounts();
  const attached = await database
    .select({
      id: atprotoConnections.id,
      status: atprotoConnections.status,
      session: atprotoConnections.session,
      importSubscriptions: atprotoConnections.importSubscriptions,
      exportSubscriptions: atprotoConnections.exportSubscriptions,
    })
    .from(atprotoConnections)
    .where(eq(atprotoConnections.userId, userId))
    .get();
  if (
    !attached?.session ||
    attached.status !== "active" ||
    (!attached.importSubscriptions && !attached.exportSubscriptions)
  )
    return { ...counts, status: "skipped" };
  const connection = await claimSubscriptionSync(database, userId);
  if (!connection) return { ...counts, status: "busy" };
  const store =
    input.dependencies?.store ??
    createPublicSubscriptionStore({
      did: connection.did,
      authorizeWrite: () =>
        assertSubscriptionSyncCurrent(database, connection, true),
    });
  let retryAt: Date | undefined;
  let changedFeeds = false;
  let wroteRecords = false;
  let cursor = connection.subscriptionSyncCursor;
  let observedCompleteSnapshot = true;
  let lastProgressAt = 0;
  const progress = async (completed: number, total: number) => {
    if (completed > 0 && completed < total && Date.now() - lastProgressAt < 100)
      return;
    lastProgressAt = Date.now();
    try {
      await input.onProgress?.({
        runId: input.runId ?? connection.subscriptionSyncToken!,
        completed,
        total,
      });
    } catch (error) {
      logError("[publication-sync] progress delivery failed", error);
    }
  };
  try {
    await progress(0, 0);
    const backfill = await (
      input.dependencies?.backfill ?? backfillPublicationOrigins
    )(database, connection);
    changedFeeds = backfill.attached > 0;
    retryAt = backfill.retryAt;
    const [previous, localOrigins, rev] = await Promise.all([
      database
        .select()
        .from(mirror)
        .where(
          and(
            eq(mirror.connectionId, connection.id),
            eq(mirror.visibility, store.visibility),
          ),
        )
        .limit(MAX_SUBSCRIPTION_RECORDS + 1),
      database
        .select({
          publicationUri: feedOrigins.locator,
          feedId: feedOrigins.feedId,
        })
        .from(feedOrigins)
        .where(
          and(eq(feedOrigins.userId, userId), eq(feedOrigins.kind, "atproto")),
        )
        .orderBy(asc(feedOrigins.feedId))
        .limit(MAX_SUBSCRIPTION_RECORDS + 1),
      store.latestRev(),
    ]);
    if (
      previous.length > MAX_SUBSCRIPTION_RECORDS ||
      localOrigins.length > MAX_SUBSCRIPTION_RECORDS
    )
      throw new Error("Too many publication subscriptions to sync safely");
    const cached = rev !== null && rev === connection.subscriptionRepoRev;
    const snapshot = cached
      ? {
          records: previous
            .filter((row) => row.remotePresent)
            .map((row) => ({
              uri: row.recordUri,
              cid: row.recordCid!,
              publicationUri: row.publicationUri,
            })),
          invalidRecordUris: [],
        }
      : await store.list();
    const invalidUris = new Set(snapshot.invalidRecordUris);
    const invalidPublications = new Set(
      previous
        .filter((row) => invalidUris.has(row.recordUri))
        .map((row) => row.publicationUri),
    );
    counts.failed += invalidUris.size;
    const remote = snapshot.records;
    if (!cached && rev !== null && (await store.latestRev()) !== rev)
      throw new Error(
        "Atmosphere subscriptions changed while reading them. Try syncing again.",
      );
    const remoteByPublication = groupByPublication(remote);
    const previousByPublication = groupByPublication(previous);
    const localByPublication = new Map<string, number>();
    for (const origin of localOrigins)
      if (!localByPublication.has(origin.publicationUri))
        localByPublication.set(origin.publicationUri, origin.feedId);
    const ordered = [
      ...new Set([
        ...remoteByPublication.keys(),
        ...previousByPublication.keys(),
        ...localByPublication.keys(),
      ]),
    ].sort();
    const publications = cursor
      ? [
          ...ordered.filter((uri) => uri > cursor!),
          ...ordered.filter((uri) => uri <= cursor!),
        ]
      : ordered;
    await progress(0, publications.length);
    const deadline = Date.now() + 60_000;
    for (const [index, publicationUri] of publications.entries()) {
      if (Date.now() > deadline) {
        counts.deferred += publications.length - index;
        observedCompleteSnapshot = false;
        break;
      }
      cursor = publicationUri;
      if (invalidPublications.has(publicationUri)) {
        await progress(index + 1, publications.length);
        continue;
      }
      let records = remoteByPublication.get(publicationUri) ?? [];
      const old = previousByPublication.get(publicationUri) ?? [];
      const previousFeedId = old[0]?.feedId ?? null;
      const localFeedId = localByPublication.get(publicationUri) ?? null;
      const priorImport = old.find((row) => row.remotePresent) ?? old[0];
      const pendingImport =
        priorImport?.importState === "pending" &&
        priorImport.importGeneration ===
          connection.subscriptionImportGeneration &&
        connection.importSubscriptions &&
        localFeedId === null &&
        records.length > 0;
      const skippedImport =
        priorImport?.importState === "skipped" &&
        priorImport.importGeneration ===
          connection.subscriptionImportGeneration &&
        connection.importSubscriptions &&
        localFeedId === null &&
        records.length > 0;
      if (skippedImport) counts.skipped++;
      if (
        pendingImport &&
        priorImport?.importRetryAt &&
        priorImport.importRetryAt > new Date()
      ) {
        if (
          !observationUnchanged(
            old,
            records,
            localFeedId,
            connection.subscriptionImportGeneration,
            connection.subscriptionExportGeneration,
          )
        ) {
          await renewSubscriptionSync(database, connection);
          await database.transaction(async (tx) => {
            await assertSubscriptionSyncCurrent(tx, connection);
            await saveSubscriptionObservation(tx, {
              connection,
              publicationUri,
              visibility: store.visibility,
              previous: old,
              records,
              feedId: null,
              imported: true,
              failure: {
                state: "pending",
                retryAt: priorImport.importRetryAt,
                attempts: priorImport.importFailures,
              },
            });
          });
        }
        counts.deferred++;
        await progress(index + 1, publications.length);
        continue;
      }
      const action = planPublicationSync({
        retryImport: pendingImport,
        localFeedId,
        previousFeedId,
        remotePresent: records.length > 0,
        previousRemotePresent: old.some((row) => row.remotePresent),
        known: old.length > 0,
        importEnabled: connection.importSubscriptions,
        exportEnabled: connection.exportSubscriptions,
        importBaseline:
          !old.length ||
          old[0]!.importGeneration !== connection.subscriptionImportGeneration,
        exportBaseline:
          !old.length ||
          old[0]!.exportGeneration !== connection.subscriptionExportGeneration,
      });
      try {
        // Most refreshes reach this fast path: no per-publication SQL or network calls.
        if (
          action === "observe" &&
          observationUnchanged(
            old,
            records,
            localFeedId,
            connection.subscriptionImportGeneration,
            connection.subscriptionExportGeneration,
          )
        ) {
          await progress(index + 1, publications.length);
          continue;
        }
        await renewSubscriptionSync(database, connection);
        let prepared: PreparedFeedImport | undefined;
        let maxActiveFeeds = 0;
        if (action === "import") {
          const details = await (
            input.dependencies?.resolveFeed ?? resolveImportedFeed
          )(userId, publicationUri);
          prepared = await prepareFeedImport(database, userId, details);
          const budget = await (
            input.dependencies?.activationBudget ?? getFeedsActivationBudget
          )(database, userId);
          maxActiveFeeds = budget.maxActiveFeeds;
        }
        if (action === "export" || action === "remove-remote") {
          await assertSubscriptionSyncCurrent(database, connection, true);
          // A Feed may have been deleted while reading the PDS listing.
          const current = await database
            .select({ id: feedOrigins.feedId })
            .from(feedOrigins)
            .where(
              and(
                eq(feedOrigins.userId, userId),
                eq(feedOrigins.kind, "atproto"),
                eq(feedOrigins.locator, publicationUri),
              ),
            )
            .get();
          if ((current?.id ?? null) !== localFeedId)
            throw new Error("Feed changed during subscription sync");
          if (action === "export")
            records = [await store.create(publicationUri)];
          else {
            for (const record of records) {
              // Recheck the grant after each delete before authorizing the next.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              await assertSubscriptionSyncCurrent(database, connection, true);
              // Each delete uses the current grant and the previous observed CID.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              await store.remove(record);
            }
            records = [];
          }
          wroteRecords = true;
        }
        const result = await database.transaction(async (tx) => {
          await assertSubscriptionSyncCurrent(tx, connection);
          let feedId = localFeedId;
          let imported = 0,
            inactive = 0,
            removed = 0;
          if (prepared) {
            const activeCount = await getActiveFeedCount(tx, userId);
            const created = await commitFeedImport(
              tx,
              userId,
              prepared,
              !connection.importAsInactive && activeCount < maxActiveFeeds,
            );
            feedId = created.feed.id;
            imported = Number(created.created || created.attached);
            inactive = Number(created.created && !created.feed.isActive);
          }
          if (action === "remove-local" && feedId !== null) {
            removed = (await deleteUserFeeds(tx, userId, [feedId])).length;
            feedId = null;
          }
          await saveSubscriptionObservation(tx, {
            connection,
            publicationUri,
            visibility: store.visibility,
            previous: old,
            records,
            feedId,
            imported: action === "import",
            failure: skippedImport
              ? {
                  state: "skipped",
                  retryAt: null,
                  attempts: priorImport?.importFailures ?? 1,
                }
              : undefined,
          });
          return { imported, inactive, removed };
        });
        counts.imported += result.imported;
        counts.inactive += result.inactive;
        counts.removed += result.removed + Number(action === "remove-remote");
        counts.exported += Number(action === "export");
        changedFeeds ||= result.imported > 0 || result.removed > 0;
      } catch (error) {
        if (
          action === "import" &&
          !(error instanceof SubscriptionSyncChangedError)
        ) {
          const skipped = error instanceof FeedImportSkippedError;
          const attempts = (priorImport?.importFailures ?? 0) + 1;
          const backoff = Math.min(
            600_000,
            60_000 * 2 ** Math.min(attempts - 1, 4),
          );
          const retryAt = skipped
            ? null
            : new Date(
                Math.max(
                  Date.now() + backoff,
                  error instanceof FeedImportDeferredError
                    ? error.retryAt.getTime()
                    : 0,
                ),
              );
          await database.transaction(async (tx) => {
            await assertSubscriptionSyncCurrent(tx, connection);
            await saveSubscriptionObservation(tx, {
              connection,
              publicationUri,
              visibility: store.visibility,
              previous: old,
              records,
              feedId: null,
              imported: true,
              failure: {
                state: skipped ? "skipped" : "pending",
                retryAt,
                attempts,
              },
            });
          });
          if (skipped) counts.skipped++;
          else counts.deferred++;
        } else counts.failed++;
        if (
          !(error instanceof FeedImportSkippedError) &&
          !(error instanceof FeedImportDeferredError)
        )
          logError(
            "[publication-sync] publication failed",
            publicationUri,
            error,
          );
        if (error instanceof SubscriptionSyncChangedError) break;
      }
      await progress(index + 1, publications.length);
    }
    await database
      .update(atprotoConnections)
      .set({
        subscriptionSyncCursor: cursor,
        subscriptionRepoRev:
          counts.failed || !observedCompleteSnapshot || wroteRecords
            ? null
            : rev,
      })
      .where(syncClaimCondition(connection));
  } catch (error) {
    counts.failed++;
    logError("[publication-sync] sync failed", error);
  } finally {
    // Pre-refresh runs also own durable continuation, including users who enabled
    // export before queued sync existed. Never replace a newer settings request.
    const nextAttemptAt = nextPublicationSyncAttempt({
      ...counts,
      status: "partial",
      retryAt,
    });
    if (nextAttemptAt) {
      await database
        .update(atprotoConnections)
        .set({
          ...newPublicationSyncRequest(true),
          subscriptionNextAttemptAt: nextAttemptAt,
        })
        .where(
          and(
            syncClaimCondition(connection),
            isNull(atprotoConnections.subscriptionNextAttemptAt),
          ),
        );
    }
    await database
      .update(atprotoConnections)
      .set({ subscriptionSyncToken: null, subscriptionSyncExpiresAt: null })
      .where(
        and(
          eq(atprotoConnections.id, connection.id),
          eq(
            atprotoConnections.subscriptionSyncToken,
            connection.subscriptionSyncToken!,
          ),
        ),
      );
    if (changedFeeds)
      await (
        input.dependencies?.invalidate ?? publishReconciliationInvalidation
      )(userId, organizationInvalidationSummary());
  }
  return {
    ...counts,
    ...(retryAt ? { retryAt } : {}),
    status:
      counts.failed || counts.deferred || counts.skipped
        ? "partial"
        : "completed",
  };
}

function observationUnchanged(
  old: DatabaseSubscriptionMirror[],
  records: SubscriptionRecord[],
  feedId: number | null,
  importGeneration: number,
  exportGeneration: number,
) {
  if (!old.length) return records.length === 0 && feedId === null;
  const byUri = new Map(records.map((record) => [record.uri, record]));
  if (records.length !== old.filter((row) => row.remotePresent).length)
    return false;
  return old.every(
    (row) =>
      (row.importState !== "pending" ||
        (feedId === null && row.remotePresent)) &&
      row.feedId === feedId &&
      row.importGeneration === importGeneration &&
      row.exportGeneration === exportGeneration &&
      row.remotePresent === byUri.has(row.recordUri) &&
      (!row.remotePresent || row.recordCid === byUri.get(row.recordUri)?.cid),
  );
}

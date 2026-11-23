import { and, asc, eq, isNull } from "drizzle-orm";
import { nextPublicationSyncAttempt, RETRY_REFUSED_WRITES } from "./requests";
import { nextRetryAt } from "./retry";
import { backfillPublicationOrigins } from "./backfill";
import {
  checkPublicationSync,
  earliest,
  listingDigest,
  syncCheckColumns,
} from "./check";
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
  scheduleUnchangedSince,
  SubscriptionSyncChangedError,
  syncClaimCondition,
} from "./state";
import type { SyncCheck, SyncCheckRow } from "./check";
import type {
  SubscriptionRecord,
  SubscriptionRecordStore,
} from "./record-store";
import type { db as Database } from "~/server/db";
import type {
  DatabaseAtprotoConnection,
  DatabaseFeedWithOrigins,
  DatabaseSubscriptionMirror,
} from "~/server/db/schema";
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
  publicationIsGone,
} from "~/server/feeds/importErrors";
import { deleteUserFeeds } from "~/server/feeds/delete";
import { refreshUserFeeds } from "~/server/rss/refreshUserFeeds";
import { fetchableOriginsOf } from "~/server/feeds/origins";
import { getUserChannel } from "~/server/api/channels";
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
/** The same bound Add gives a new Feed's first fetch. */
const FIRST_FETCH_TIMEOUT_MS = 15_000;

/** The PDS did not take a subscription write. The write is still owed. */
class SubscriptionWriteError extends Error {}

/** A lost claim ends the run as it always did; any other failure is the write's. */
async function writeSubscription<T>(write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if (error instanceof SubscriptionSyncChangedError) throw error;
    throw new SubscriptionWriteError("Subscription write failed", {
      cause: error,
    });
  }
}

/**
 * A Feed the sync created gets its first content at once, like a Feed the user
 * added by hand: every origin, published to the user's channel. This runs
 * outside the user's refresh window, bounded to Feeds this run created and to
 * the Add path's timeout so one slow publication cannot hold the sync claim.
 */
async function fetchCreatedFeed(
  database: typeof Database,
  feed: DatabaseFeedWithOrigins,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      refreshUserFeeds({
        db: database,
        feedsList: fetchableOriginsOf([feed]),
        channel: getUserChannel(feed.userId),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("First fetch timed out")),
          FIRST_FETCH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function resolveImportedFeed(userId: string, publicationUri: string) {
  const { resolvePublicationFeed } =
    await import("~/server/feeds/resolveSelection");
  const [details] = await resolvePublicationFeed(userId, publicationUri);
  if (!details) throw new Error("Unable to resolve publication");
  return details;
}

type WriteRetries = Pick<
  DatabaseAtprotoConnection,
  "subscriptionWriteFailures" | "subscriptionWriteRetryAt"
>;

/**
 * Subscription writes the PDS refuses share one wait on the connection, on
 * the shared retry rule. A pass that meets a refusal counts one failure and
 * sets the time of the next attempt. Until that time a pass leaves owed writes
 * alone, whatever started it, so only waits that were served are counted.
 * Once the retries run out the writes wait for the count to start over.
 */
function refusedWriteRetries(connection: WriteRetries, now = new Date()) {
  const failures = connection.subscriptionWriteFailures;
  const retryAt = connection.subscriptionWriteRetryAt;
  // Only these two columns: the caller hands in a whole connection row.
  const stored: WriteRetries = {
    subscriptionWriteFailures: failures,
    subscriptionWriteRetryAt: retryAt,
  };
  /** The retries ran out: a count with no time left to wait for. */
  const stopped = failures > 0 && retryAt === null;
  const waitsUntil = retryAt !== null && retryAt > now ? retryAt : null;
  let leftOwed = false;
  let refusal: WriteRetries | undefined;
  return {
    /** Why this pass attempts no write, or null when it may. */
    held: stopped
      ? ({ stopped: true } as const)
      : waitsUntil && ({ stopped: false, until: waitsUntil } as const),
    /** An owed write this pass left unattempted. */
    leaveOwed() {
      leftOwed = true;
    },
    /** The PDS refused a write. Resolves to when the next attempt may run. */
    refuse() {
      refusal ??= {
        subscriptionWriteFailures: failures + 1,
        subscriptionWriteRetryAt: nextRetryAt(failures + 1),
      };
      return refusal.subscriptionWriteRetryAt;
    },
    /**
     * What the connection stores after the pass: one more failure, nothing
     * once a whole pass owed no write, and otherwise what it held.
     */
    finished(sawEveryPublication: boolean): WriteRetries {
      if (refusal) return refusal;
      return sawEveryPublication && !leftOwed ? RETRY_REFUSED_WRITES : stored;
    },
  };
}

/**
 * The listing at `rev` is the one the last finished run saw, so only the
 * revision is new. The write lands while the revision the check compared
 * against still stands: a Feed change, a settings save or a run replaces it.
 */
async function saveCheckedRev(
  database: typeof Database,
  checked: Pick<SyncCheckRow, "id" | "subscriptionRepoRev">,
  rev: string,
) {
  await database
    .update(atprotoConnections)
    .set({ subscriptionRepoRev: rev })
    .where(
      and(
        eq(atprotoConnections.id, checked.id),
        // A check only compares a listing against a stored revision.
        eq(
          atprotoConnections.subscriptionRepoRev,
          checked.subscriptionRepoRev!,
        ),
      ),
    );
}

export async function syncPublicationSubscriptions(input: {
  database: typeof Database;
  userId: string;
  runId?: string;
  /** A caller that already checked, to decide before claiming its own work. */
  check?: SyncCheck;
  onProgress?: (progress: PublicationSyncProgress) => Promise<void>;
  dependencies?: {
    backfill?: typeof backfillPublicationOrigins;
    store?: SubscriptionRecordStore;
    resolveFeed?: typeof resolveImportedFeed;
    fetchCreatedFeed?: typeof fetchCreatedFeed;
    activationBudget?: typeof getFeedsActivationBudget;
    invalidate?: typeof publishReconciliationInvalidation;
  };
}): Promise<PublicationSyncResult> {
  const { database, userId } = input;
  const counts = emptyPublicationSyncCounts();
  const injectedStore = input.dependencies?.store;
  const checked = input.check
    ? undefined
    : await database
        .select(syncCheckColumns)
        .from(atprotoConnections)
        .where(eq(atprotoConnections.userId, userId))
        .get();
  const check =
    input.check ??
    (await checkPublicationSync(
      checked,
      injectedStore && {
        latestRev: () => injectedStore.latestRev(),
        list: () => injectedStore.list(),
      },
    ));
  if (check.state === "disabled") return { ...counts, status: "skipped" };
  // Nothing changed on either side: no claim and no reads. A revision that
  // moved under an unchanged listing costs the one write that stores it.
  if (check.state === "current") {
    if (checked && check.rev !== undefined)
      await saveCheckedRev(database, checked, check.rev);
    return { ...counts, status: "completed" };
  }
  const connection = await claimSubscriptionSync(database, userId);
  if (!connection) return { ...counts, status: "busy" };
  const store =
    input.dependencies?.store ??
    createPublicSubscriptionStore({
      did: connection.did,
      authorizeWrite: () =>
        assertSubscriptionSyncCurrent(database, connection, true),
    });
  let retryAt = null as Date | null;
  const retryAfter = (next: Date) => {
    retryAt = earliest(retryAt, next);
  };
  /**
   * The earliest import or PDS write waiting for its retry time, which the
   * connection stores so checks stay idle until then.
   */
  let waitingRetryAt = null as Date | null;
  const awaitRetry = (next: Date) => {
    retryAfter(next);
    waitingRetryAt = earliest(waitingRetryAt, next);
  };
  /** Failed work with no retry time of its own, for the next check to redo. */
  let mustReconcile = false;
  let changedFeeds = false;
  /** Publishes every Feed change so far; later changes publish again at the end. */
  const publishFeedChanges = async () => {
    await (input.dependencies?.invalidate ?? publishReconciliationInvalidation)(
      userId,
      organizationInvalidationSummary(),
    );
    changedFeeds = false;
  };
  /** Clients learn the Feed before its items arrive, as with Add. */
  const fetchAfterImport = async (feed: DatabaseFeedWithOrigins) => {
    try {
      await renewSubscriptionSync(database, connection);
      await publishFeedChanges();
      await (input.dependencies?.fetchCreatedFeed ?? fetchCreatedFeed)(
        database,
        feed,
      );
    } catch (error) {
      if (error instanceof SubscriptionSyncChangedError) throw error;
      // The Feed exists either way; content failures surface on the Feed itself.
      logError("[publication-sync] first fetch failed", error);
    }
  };
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
    retryAt = backfill.retryAt ?? null;
    // An origin backfill attached is a new export to make, like a Feed change.
    const writeRetries = refusedWriteRetries(
      backfill.attached > 0 ? RETRY_REFUSED_WRITES : connection,
    );
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
      check.rev === undefined ? store.latestRev() : check.rev,
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
      : // The check read the listing after this revision; one read serves both.
        (check.listing ?? (await store.list()));
    // A cached snapshot is the listing the stored digest already describes.
    const snapshotDigest = cached
      ? connection.subscriptionListingDigest
      : listingDigest(snapshot);
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
        retryAfter(new Date());
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
        awaitRetry(priorImport.importRetryAt);
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
        const writesRecord = action === "export" || action === "remove-remote";
        if (writesRecord && writeRetries.held) {
          writeRetries.leaveOwed();
          if (writeRetries.held.stopped) counts.skipped++;
          else {
            counts.deferred++;
            awaitRetry(writeRetries.held.until);
          }
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
        if (writesRecord) {
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
          if (action === "export") {
            records = [
              await writeSubscription(() => store.create(publicationUri)),
            ];
            wroteRecords = true;
          } else {
            for (const record of records) {
              // Recheck the grant after each delete before authorizing the next.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              await assertSubscriptionSyncCurrent(database, connection, true);
              // Each delete uses the current grant and the previous observed CID.
              // react-doctor-disable-next-line react-doctor/async-await-in-loop
              await writeSubscription(() => store.remove(record));
              // A removal that landed changed the repository, even if a later one fails.
              wroteRecords = true;
            }
            records = [];
          }
        }
        const result = await database.transaction(async (tx) => {
          await assertSubscriptionSyncCurrent(tx, connection);
          let feedId = localFeedId;
          let imported = 0,
            inactive = 0,
            removed = 0,
            createdFeed: DatabaseFeedWithOrigins | null = null;
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
            if (created.created && created.feed.isActive)
              createdFeed = created.feed;
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
          return { imported, inactive, removed, createdFeed };
        });
        counts.imported += result.imported;
        counts.inactive += result.inactive;
        counts.removed += result.removed + Number(action === "remove-remote");
        counts.exported += Number(action === "export");
        changedFeeds ||= result.imported > 0 || result.removed > 0;
        // The import is committed; nothing below may be read as its failure.
        if (result.createdFeed) await fetchAfterImport(result.createdFeed);
      } catch (error) {
        if (
          action === "import" &&
          !(error instanceof SubscriptionSyncChangedError)
        ) {
          const attempts = (priorImport?.importFailures ?? 0) + 1;
          // A completed mismatch and a publication that is gone end here; any
          // other failure may recover and retries until its backoff runs out.
          const backoff =
            error instanceof FeedImportSkippedError || publicationIsGone(error)
              ? null
              : nextRetryAt(attempts);
          const retryImportAt =
            backoff &&
            new Date(
              Math.max(
                backoff.getTime(),
                error instanceof FeedImportDeferredError
                  ? error.retryAt.getTime()
                  : 0,
              ),
            );
          const skipped = retryImportAt === null;
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
                retryAt: retryImportAt,
                attempts,
              },
            });
          });
          if (retryImportAt === null) counts.skipped++;
          else {
            counts.deferred++;
            awaitRetry(retryImportAt);
          }
        } else if (error instanceof SubscriptionWriteError) {
          // The export or removal waits its turn like a failed import, so the
          // checks in between stay idle instead of each retrying the write.
          counts.failed++;
          const retryWriteAt = writeRetries.refuse();
          if (retryWriteAt) awaitRetry(retryWriteAt);
        } else {
          counts.failed++;
          mustReconcile = true;
        }
        if (
          !(error instanceof FeedImportSkippedError) &&
          !(error instanceof FeedImportDeferredError) &&
          !publicationIsGone(error)
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
    // A stored revision promises a finished pass over a complete snapshot, with
    // nothing left but retries waiting for their time. An invalid record is
    // part of that snapshot: the same revision yields it again.
    const finishedRev =
      mustReconcile || !observedCompleteSnapshot || wroteRecords ? null : rev;
    // The digest describes the listing at the stored revision and means
    // nothing without one, so a pass that stores none leaves it alone.
    const finishedDigest =
      finishedRev === null
        ? connection.subscriptionListingDigest
        : snapshotDigest;
    const finishedWrites = writeRetries.finished(
      observedCompleteSnapshot && !mustReconcile,
    );
    if (
      cursor !== connection.subscriptionSyncCursor ||
      finishedRev !== connection.subscriptionRepoRev ||
      finishedDigest !== connection.subscriptionListingDigest ||
      waitingRetryAt?.getTime() !== connection.subscriptionRetryAt?.getTime() ||
      finishedWrites.subscriptionWriteFailures !==
        connection.subscriptionWriteFailures ||
      finishedWrites.subscriptionWriteRetryAt?.getTime() !==
        connection.subscriptionWriteRetryAt?.getTime()
    )
      await database
        .update(atprotoConnections)
        .set({
          subscriptionSyncCursor: cursor,
          subscriptionRepoRev: finishedRev,
          subscriptionListingDigest: finishedDigest,
          subscriptionRetryAt: waitingRetryAt,
          ...finishedWrites,
        })
        .where(
          and(
            syncClaimCondition(connection),
            // A Feed changed after this run read the local origins.
            scheduleUnchangedSince(connection.subscriptionNextAttemptAt),
          ),
        );
  } catch (error) {
    counts.failed++;
    logError("[publication-sync] sync failed", error);
  } finally {
    // A run outside the job queue, such as one before a manual refresh, still
    // owes its unfinished work a schedule. It never opens a request of its
    // own: only the user starts one, so the follow-up runs unannounced.
    const nextAttemptAt = nextPublicationSyncAttempt({
      ...counts,
      status: "partial",
      ...(retryAt ? { retryAt } : {}),
    });
    if (nextAttemptAt) {
      await database
        .update(atprotoConnections)
        .set({ subscriptionNextAttemptAt: nextAttemptAt })
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
    if (changedFeeds) await publishFeedChanges();
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
  // Never observed and nothing upstream: there is no mirror row to write.
  if (!old.length) return records.length === 0;
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

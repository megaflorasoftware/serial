import { eq } from "drizzle-orm";
import { listingDigest } from "../../src/server/publication-sync/check";
import { syncPublicationSubscriptions } from "../../src/server/publication-sync/engine";
import { runPublicationSyncJobs } from "../../src/server/publication-sync/jobs";
import {
  atprotoConnections,
  atprotoSubscriptionMirror,
  feedOrigins,
  feeds,
  user,
} from "../../src/server/db/schema";
import { FIXTURE_NEXT_FETCH_AT } from "./fixtures";
import type { db as Database } from "../../src/server/db";
import type {
  SubscriptionListing,
  SubscriptionRecord,
} from "../../src/server/publication-sync/record-store";
import { feedOriginAtproto } from "~/server/db/schema";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";

/**
 * `unchanged`: an inline run that finds neither side changed.
 * `check`: the recurring job check that finds neither side changed.
 * `waiting`: the same check while an import waits for a retry that is not due.
 * `moved`: the same check after a post or a like moved the repository
 * revision and left the subscriptions as they were.
 * `changed`: the same check after another app rewrote one subscription, and
 * the run it starts.
 * `requested`: a full pass a local change asked for, over publications that
 * turn out to be unchanged.
 */
export const PUBLICATION_SYNC_OPERATIONS = [
  "unchanged",
  "check",
  "waiting",
  "moved",
  "changed",
  "requested",
] as const;
export type PublicationSyncOperation =
  (typeof PUBLICATION_SYNC_OPERATIONS)[number];

export async function createPublicationSyncWorkload(
  database: typeof Database,
  count: number,
  operation: PublicationSyncOperation = "unchanged",
) {
  const userId = "publication-sync-benchmark";
  const did = "did:plc:abcdefghijklmnopqrstuvwx";
  await database.insert(user).values({
    id: userId,
    name: "Benchmark",
    email: "publication-sync@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await database.insert(atprotoConnections).values({
    id: userId,
    userId,
    did,
    session: "test",
    status: "active",
    importSubscriptions: true,
    exportSubscriptions: true,
    subscriptionRepoRev: "unchanged",
    // The user's own request settled long ago; what runs now is background work.
    subscriptionRequestId: "settled-request",
    subscriptionJobResult: {
      ...emptyPublicationSyncCounts(),
      status: "completed",
    },
  });
  const records: SubscriptionRecord[] = [];
  for (let offset = 0; offset < count; offset += 50) {
    // Seed one bounded batch at a time so fixture setup cannot flood the driver.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const rows = await database
      .insert(feeds)
      .values(
        Array.from({ length: Math.min(50, count - offset) }, (_, index) => ({
          userId,
          name: `Publication ${offset + index}`,
          platform: "website" as const,
          isActive: true,
        })),
      )
      .returning({ id: feeds.id });
    const publicationUri = (id: number) =>
      `at://${did}/site.standard.publication/${id}`;
    const originRows = await database
      .insert(feedOrigins)
      .values(
        rows.map((row) => ({
          userId,
          feedId: row.id,
          kind: "atproto",
          locator: publicationUri(row.id),
          nextFetchAt: FIXTURE_NEXT_FETCH_AT,
        })),
      )
      .returning({ id: feedOrigins.id });
    await database.insert(feedOriginAtproto).values(
      originRows.map((origin) => ({
        originId: origin.id,
        publicationDid: did,
      })),
    );
    const page = rows.map((row) => ({
      feedId: row.id,
      record: {
        uri: `at://${did}/site.standard.graph.subscription/${row.id}`,
        cid: "cid",
        publicationUri: publicationUri(row.id),
      },
    }));
    records.push(...page.map((entry) => entry.record));
    await database.insert(atprotoSubscriptionMirror).values(
      page.map(({ feedId, record }) => ({
        connectionId: userId,
        publicationUri: record.publicationUri,
        recordUri: record.uri,
        recordCid: record.cid,
        feedId,
        provenance: "serial" as const,
        remotePresent: true,
      })),
    );
  }
  if (operation === "waiting") {
    // One subscription whose import failed and now waits out its backoff.
    const retryAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await database.insert(atprotoSubscriptionMirror).values({
      connectionId: userId,
      publicationUri: `at://${did}/site.standard.publication/waiting`,
      recordUri: `at://${did}/site.standard.graph.subscription/waiting`,
      recordCid: "cid",
      feedId: null,
      provenance: "imported",
      remotePresent: true,
      importState: "pending",
      importRetryAt: retryAt,
      importFailures: 12,
    });
    await database
      .update(atprotoConnections)
      .set({ subscriptionRetryAt: retryAt })
      .where(eq(atprotoConnections.id, userId));
  }
  const listing: SubscriptionListing = { records, invalidRecordUris: [] };
  /** The same subscriptions with the first one rewritten in another app. */
  const rewritten: SubscriptionListing = {
    records: records.map((record, index) =>
      index === 0 ? { ...record, cid: "rewritten" } : record,
    ),
    invalidRecordUris: [],
  };
  const setConnection = (
    values: Partial<typeof atprotoConnections.$inferInsert>,
  ) =>
    database
      .update(atprotoConnections)
      .set(values)
      .where(eq(atprotoConnections.id, userId));
  // The last finished run saw this listing at the stored revision.
  await setConnection({ subscriptionListingDigest: listingDigest(listing) });
  /** Every PDS request: a revision read or a listing. */
  let requests = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unchanged sync attempted publication work");
  };
  const revisionMoved = operation === "moved" || operation === "changed";
  const latestRev = async () => {
    requests++;
    return revisionMoved ? "moved" : "unchanged";
  };
  const list = {
    unchanged: unexpected,
    check: unexpected,
    waiting: unexpected,
    moved: () => Promise.resolve(listing),
    changed: () => Promise.resolve(rewritten),
    requested: () => Promise.resolve(listing),
  }[operation];
  const store = {
    visibility: "public" as const,
    latestRev,
    list: async () => {
      requests++;
      return list();
    },
    create: unexpected,
    remove: unexpected,
  };
  const dependencies = {
    store,
    resolveFeed: unexpected,
    invalidate: unexpected,
  };
  const sync = () =>
    syncPublicationSubscriptions({ database, userId, dependencies });
  const checkDue = { subscriptionNextAttemptAt: new Date(0) };
  const lastFinishedRun = { ...checkDue, subscriptionRepoRev: "unchanged" };
  const checkWith =
    (run: Parameters<typeof runPublicationSyncJobs>[1]) => async () => {
      await runPublicationSyncJobs(database, run, {
        remote: { latestRev, list: store.list },
        refreshesInBackground: () => Promise.resolve(true),
        announce: unexpected,
      });
      return { status: "checked" as const };
    };
  const check = {
    prepare: () => setConnection(checkDue),
    run: checkWith(unexpected),
  };
  const operations = {
    unchanged: { prepare: () => Promise.resolve(), run: sync },
    check,
    waiting: check,
    moved: {
      prepare: () => setConnection(lastFinishedRun),
      run: checkWith(unexpected),
    },
    changed: {
      async prepare() {
        await setConnection({
          ...lastFinishedRun,
          subscriptionListingDigest: listingDigest(listing),
        });
        await database
          .update(atprotoSubscriptionMirror)
          .set({ recordCid: "cid" })
          .where(eq(atprotoSubscriptionMirror.recordCid, "rewritten"));
      },
      run: checkWith((input) =>
        syncPublicationSubscriptions({ ...input, dependencies }),
      ),
    },
    requested: {
      prepare: () => setConnection({ subscriptionRepoRev: null }),
      run: sync,
    },
  };
  return {
    get requests() {
      return requests;
    },
    /** Restore the state the operation starts from; not part of the measurement. */
    async prepare() {
      await operations[operation].prepare();
    },
    async run() {
      requests = 0;
      return operations[operation].run();
    },
  };
}

import { eq } from "drizzle-orm";
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
import type { SubscriptionRecord } from "../../src/server/publication-sync/record-store";
import { feedOriginAtproto } from "~/server/db/schema";

/**
 * `unchanged`: an inline run that finds neither side changed.
 * `check`: the recurring job check that finds neither side changed.
 * `requested`: a full pass a local change asked for, over publications that
 * turn out to be unchanged.
 */
export const PUBLICATION_SYNC_OPERATIONS = [
  "unchanged",
  "check",
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
  let requests = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unchanged sync attempted publication work");
  };
  const latestRev = async () => {
    requests++;
    return "unchanged";
  };
  const sync = () =>
    syncPublicationSubscriptions({
      database,
      userId,
      dependencies: {
        store: {
          visibility: "public",
          latestRev,
          list:
            operation === "requested"
              ? async () => ({ records, invalidRecordUris: [] })
              : unexpected,
          create: unexpected,
          remove: unexpected,
        },
        resolveFeed: unexpected,
        invalidate: unexpected,
      },
    });
  const setConnection = (
    values: Partial<typeof atprotoConnections.$inferInsert>,
  ) =>
    database
      .update(atprotoConnections)
      .set(values)
      .where(eq(atprotoConnections.id, userId));
  const operations = {
    unchanged: { prepare: () => Promise.resolve(), run: sync },
    check: {
      prepare: () => setConnection({ subscriptionNextAttemptAt: new Date(0) }),
      run: async () => {
        await runPublicationSyncJobs(database, unexpected, {
          latestRev,
          refreshesInBackground: () => Promise.resolve(true),
        });
        return { status: "checked" as const };
      },
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

import { syncPublicationSubscriptions } from "../../src/server/publication-sync/engine";
import {
  atprotoConnections,
  atprotoSubscriptionMirror,
  feedOrigins,
  feeds,
  user,
} from "../../src/server/db/schema";
import type { db as Database } from "../../src/server/db";

export async function createPublicationSyncWorkload(
  database: typeof Database,
  count: number,
) {
  const userId = "publication-sync-benchmark";
  const did = "did:plc:abcdefghijklmnopqrstuvwx";
  await database
    .insert(user)
    .values({
      id: userId,
      name: "Benchmark",
      email: "publication-sync@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await database
    .insert(atprotoConnections)
    .values({
      id: userId,
      userId,
      did,
      session: "test",
      status: "active",
      importSubscriptions: true,
      exportSubscriptions: true,
      subscriptionRepoRev: "unchanged",
    });
  for (let offset = 0; offset < count; offset += 50) {
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
    await database
      .insert(feedOrigins)
      .values(
        rows.map((row) => ({
          userId,
          feedId: row.id,
          kind: "atproto",
          locator: publicationUri(row.id),
        })),
      );
    await database
      .insert(atprotoSubscriptionMirror)
      .values(
        rows.map((row) => ({
          connectionId: userId,
          publicationUri: publicationUri(row.id),
          recordUri: `at://${did}/site.standard.graph.subscription/${row.id}`,
          recordCid: "cid",
          feedId: row.id,
          provenance: "serial" as const,
          remotePresent: true,
        })),
      );
  }
  let requests = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("Unchanged sync attempted publication work");
  };
  return {
    get requests() {
      return requests;
    },
    async run() {
      requests = 0;
      return syncPublicationSubscriptions({
        database,
        userId,
        dependencies: {
          store: {
            visibility: "public",
            latestRev: async () => {
              requests++;
              return "unchanged";
            },
            list: unexpected,
            create: unexpected,
            remove: unexpected,
          },
          resolveFeed: unexpected,
          invalidate: unexpected,
        },
      });
    },
  };
}

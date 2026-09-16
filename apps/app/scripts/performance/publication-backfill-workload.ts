import { eq } from "drizzle-orm";
import { backfillPublicationOrigins } from "../../src/server/publication-sync/backfill";
import { claimSubscriptionSync } from "../../src/server/publication-sync/state";
import {
  atprotoConnections,
  feedOrigins,
  feeds,
  publicationBackfillProbes,
  user,
} from "../../src/server/db/schema";
import type { db } from "../../src/server/db";

export async function createPublicationBackfillWorkload(
  database: typeof db,
  count: number,
) {
  const userId = "backfill-benchmark";
  await database
    .insert(user)
    .values({
      id: userId,
      name: "Benchmark",
      email: "backfill@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  await database
    .insert(atprotoConnections)
    .values({
      id: userId,
      userId,
      did: "did:plc:abcdefghijklmnopqrstuvwx",
      session: "fixture",
      scopes: "atproto include:site.standard.authSocial",
      exportSubscriptions: true,
    });
  for (let offset = 0; offset < count; offset += 50) {
    const rows = await database
      .insert(feeds)
      .values(
        Array.from({ length: Math.min(50, count - offset) }, (_, index) => ({
          userId,
          name: `Feed ${offset + index}`,
          platform: "website" as const,
          siteUrl: "https://example.com",
        })),
      )
      .returning({ id: feeds.id });
    await database
      .insert(feedOrigins)
      .values(
        rows.map(({ id }) => ({
          userId,
          feedId: id,
          kind: "rss",
          locator: `https://example.com/feed/${id}`,
        })),
      );
  }
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    async prepare() {
      await database.delete(publicationBackfillProbes);
      await database
        .update(atprotoConnections)
        .set({
          subscriptionBackfillStarted: false,
          subscriptionBackfillNextAttemptAt: null,
          subscriptionSyncToken: null,
          subscriptionSyncExpiresAt: null,
        })
        .where(eq(atprotoConnections.id, userId));
    },
    async run() {
      requests = 0;
      const connection = (await claimSubscriptionSync(database, userId))!;
      return backfillPublicationOrigins(database, connection, {
        readOriginEvidence: (origin) => {
          requests++;
          return Promise.resolve({
            origin: { ...origin },
            siteUrl: "https://example.com",
            itemUrls: new Set(["https://example.com/article"]),
          });
        },
        readBackfillPublication: () => {
          requests++;
          return Promise.resolve(null);
        },
      });
    },
  };
}

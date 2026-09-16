import { and, eq } from "drizzle-orm";
import {
  commitFeedImport,
  prepareFeedImport,
} from "../../src/server/feeds/imports";
import { feedOrigins, feeds, user } from "../../src/server/db/schema";
import { newRssFeedDetails } from "../../src/server/rss/types";
import type { db as Database } from "../../src/server/db";

/** Measure verified attachment among unrelated owned Feeds, with deterministic source evidence. */
export async function createFeedImportWorkload(
  database: typeof Database,
  count: number,
) {
  const userId = "feed-import-benchmark";
  await database.insert(user).values({
    id: userId,
    name: "Benchmark",
    email: "feed-import@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let targetId = 0;
  const selected = Math.floor(count / 2);
  for (let offset = 0; offset < count; offset += 50) {
    // Serialize fixture batches to bound SQLite writes and memory.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const rows = await database
      .insert(feeds)
      .values(
        Array.from({ length: Math.min(50, count - offset) }, (_, index) => ({
          userId,
          name: `Feed ${offset + index}`,
          siteUrl: `https://site-${offset + index}.example.com`,
          platform: "website",
          isActive: false,
        })),
      )
      .returning({ id: feeds.id, siteUrl: feeds.siteUrl });
    // Origin rows depend on the generated Feed IDs from this batch.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await database.insert(feedOrigins).values(
      rows.map((row) => ({
        feedId: row.id,
        userId,
        kind: "atproto",
        locator: `at://did:plc:example/site.standard.publication/${row.id}`,
      })),
    );
    targetId ||=
      rows.find((row) => row.siteUrl === `https://site-${selected}.example.com`)
        ?.id ?? 0;
  }
  const siteUrl = `https://site-${selected}.example.com`;
  const details = newRssFeedDetails({
    name: "RSS",
    platform: "website",
    siteUrl,
    url: `${siteUrl}/rss`,
  });
  let sourceReads = 0;
  return {
    get sourceReads() {
      return sourceReads;
    },
    async reset() {
      sourceReads = 0;
      await database
        .delete(feedOrigins)
        .where(
          and(eq(feedOrigins.feedId, targetId), eq(feedOrigins.kind, "rss")),
        );
    },
    async run() {
      const prepared = await prepareFeedImport(database, userId, details, {
        readOriginEvidence: (origin) => {
          sourceReads++;
          return Promise.resolve({
            origin,
            siteUrl,
            itemUrls: new Set([`${siteUrl}/article`]),
          });
        },
      });
      return database.transaction(
        (tx) => commitFeedImport(tx, userId, prepared, true),
        { behavior: "immediate" },
      );
    },
  };
}

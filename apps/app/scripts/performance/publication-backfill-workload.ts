import { asc, notInArray } from "drizzle-orm";
import { backfillPublicationOrigin } from "../../src/server/origin-checks/backfill";
import { queuePublicationBackfill } from "../../src/server/origin-checks/queue";
import { runFeedOriginChecks } from "../../src/server/origin-checks/worker";
import {
  feedOriginChecks,
  feedOrigins,
  feeds,
  user,
} from "../../src/server/db/schema";
import { FIXTURE_NEXT_FETCH_AT } from "./fixtures";
import type { db } from "../../src/server/db";
import { feedOriginRss } from "~/server/db/schema";

/** How many queued checks a measured run finds due. */
export const BACKFILL_BENCHMARK_CHECKS = 8;

/**
 * Publication backfill through the Feed origin check queue, among `count`
 * RSS-only Feeds. Network reads are stubbed and counted.
 */
export async function createPublicationBackfillWorkload(
  database: typeof db,
  count: number,
) {
  const userId = "backfill-benchmark";
  await database.insert(user).values({
    id: userId,
    name: "Benchmark",
    email: "backfill@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  for (let offset = 0; offset < count; offset += 50) {
    // Bound fixture writes so seeding does not flood the database driver.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
    const originRows = await database
      .insert(feedOrigins)
      .values(
        rows.map(({ id }) => ({
          userId,
          feedId: id,
          kind: "rss",
          locator: `https://example.com/feed/${id}`,
          nextFetchAt: FIXTURE_NEXT_FETCH_AT,
        })),
      )
      .returning({ id: feedOrigins.id });
    await database
      .insert(feedOriginRss)
      .values(originRows.map((origin) => ({ originId: origin.id })));
  }
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    /** Queues every Feed, as enabling export does, and leaves a few due. */
    async prepare() {
      await database.delete(feedOriginChecks);
      await queuePublicationBackfill(database, userId);
      await database
        .update(feedOriginChecks)
        .set({ nextAttemptAt: new Date(Date.now() + 86_400_000) })
        .where(
          notInArray(
            feedOriginChecks.feedId,
            database
              .select({ feedId: feedOriginChecks.feedId })
              .from(feedOriginChecks)
              .orderBy(asc(feedOriginChecks.feedId))
              .limit(BACKFILL_BENCHMARK_CHECKS),
          ),
        );
    },
    async run() {
      requests = 0;
      const more = await runFeedOriginChecks(database, {
        backfill: (checked, owner, feedId) =>
          backfillPublicationOrigin(checked, owner, feedId, {
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
          }),
        publish: () => Promise.resolve(),
      });
      return { more };
    },
  };
}

import { and, eq } from "drizzle-orm";
import type { BenchmarkDatabase } from "./database";
import type { OriginEvidence } from "~/server/feeds/revalidationEvidence";
import { revalidateFeed } from "~/server/feeds/revalidate";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { feedItems, feedOrigins, user } from "~/server/db/schema";

/** Fixed source evidence isolates orchestration/database cost from remote host latency. */
export async function createFeedRevalidationWorkload(
  database: BenchmarkDatabase,
  historySize: number,
) {
  const userId = "revalidation-benchmark";
  const now = new Date();
  await database.insert(user).values({
    id: userId,
    name: "Reader",
    email: "revalidation@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const rss: OriginEvidence = {
    origin: {
      kind: "rss",
      locator: "https://example.com/feed",
      sourceName: "RSS",
    },
    siteUrl: "https://example.com",
    itemUrls: new Set(["https://example.com/one"]),
  };
  const publication: OriginEvidence = {
    origin: {
      kind: "atproto",
      locator: "at://did:plc:example/site.standard.publication/site",
      sourceName: "Publication",
    },
    siteUrl: rss.siteUrl,
    itemUrls: rss.itemUrls,
  };
  const feed = await insertFeedWithOrigins(database, {
    userId,
    isActive: true,
    details: { name: "RSS", platform: "website", origins: [rss.origin] },
  });
  for (let offset = 0; offset < historySize; offset += 100) {
    await database.insert(feedItems).values(
      Array.from({ length: Math.min(100, historySize - offset) }, (_, i) => ({
        id: `history-${offset + i}`,
        contentId: `history-${offset + i}`,
        feedId: feed.id,
        title: "Article",
        author: "Author",
        url: `https://example.com/${offset + i}`,
        postedAt: now,
      })),
    );
  }
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async prepare() {
      await database
        .delete(feedOrigins)
        .where(
          and(eq(feedOrigins.feedId, feed.id), eq(feedOrigins.kind, "atproto")),
        );
      reads = 0;
    },
    run() {
      return revalidateFeed(database, userId, feed.id, {
        readOriginEvidence: async (origin) => {
          reads++;
          return origin.kind === "rss" ? rss : publication;
        },
        discoverFeedOriginsForRevalidation: async () => {
          reads++;
          return [
            {
              url: "https://example.com",
              origins: [
                {
                  kind: "atproto" as const,
                  locator: publication.origin.locator,
                },
              ],
            },
          ];
        },
      });
    },
  };
}

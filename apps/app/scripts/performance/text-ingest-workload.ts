import type { BenchmarkDatabase } from "./database";
import type { RSSContent } from "~/server/rss/types";
import type { ContentType } from "~/lib/content/descriptor";
import { feeds, user } from "~/server/db/schema";
import { ingestRssItems } from "~/server/rss/ingestRssItems";
import { parsedFeedDigest } from "~/server/rss/parsedFeedDigest";

export type TextIngestOperation = "unchanged" | "changed";

/** A body the size of a long article, so reading it would show. */
const BODY = `<p>${"Retained article body. ".repeat(400)}</p>`;

/**
 * One text Feed whose document is already ingested. `unchanged` ingests the
 * same items again, as a fetch does when the feed restates them; `changed`
 * ingests them with a few edited. `digest` is what every fetch computes first,
 * to skip the ingest of a feed that parses as it did.
 */
export async function createTextIngestWorkload(
  database: BenchmarkDatabase,
  size: number,
) {
  const now = new Date();
  await database.insert(user).values({
    id: "text-ingest-benchmark",
    name: "Reader",
    email: "text-ingest@benchmark.invalid",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const [feed] = await database
    .insert(feeds)
    .values({
      userId: "text-ingest-benchmark",
      name: "Blog",
      platform: "website",
      imageUrl: "",
    })
    .returning();
  let revision = 0;
  const item = (index: number, edited = false): RSSContent => ({
    id: `guid-${index}`,
    url: `https://example.com/posts/${index}`,
    title: edited ? `Post ${index}, revision ${revision}` : `Post ${index}`,
    author: "Author",
    publishedDate: "2026-09-15T12:00:00Z",
    content: BODY,
    thumbnail: "https://example.com/cover.png",
    mediaThumbnail: "https://example.com/cover.png",
  });
  const document = (changed: number) =>
    Array.from({ length: size }, (_, index) => item(index, index < changed));
  let pages = 0;
  const ingest = (items: RSSContent[]) =>
    ingestRssItems(database, feed!, items, () => {
      pages++;
      return Promise.reject(new Error("A settled item fetched its page"));
    });
  await ingest(document(0));
  return {
    get pages() {
      return pages;
    },
    digest(medium: ContentType) {
      return parsedFeedDigest(medium, document(0));
    },
    async run(operation: TextIngestOperation, changed = 0) {
      revision++;
      const written = await ingest(
        document(operation === "changed" ? changed : 0),
      );
      return { written: written.items.length };
    },
  };
}

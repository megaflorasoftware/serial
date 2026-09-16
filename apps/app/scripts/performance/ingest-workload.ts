import { eq } from "drizzle-orm";
import type { BenchmarkDatabase } from "./database";
import type { PublicationClient } from "~/server/rss/atprotoClient";
import { feedItems, feedOrigins, feeds, user } from "~/server/db/schema";
import { ingestAtmosphere } from "~/server/rss/ingestAtmosphere";

export async function createIngestWorkload(
  database: BenchmarkDatabase,
  historySize: number,
) {
  const now = new Date("2026-09-15T12:00:00Z");
  await database
    .insert(user)
    .values({
      id: "ingest-benchmark",
      name: "Ingest benchmark",
      email: "ingest@benchmark.invalid",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  const feed = (
    await database
      .insert(feeds)
      .values({
        userId: "ingest-benchmark",
        name: "Publication",
        platform: "website",
        siteUrl: "https://example.com",
        imageUrl: "",
        isActive: true,
      })
      .returning()
  )[0]!;
  const publication = "at://did:plc:benchmark/site.standard.publication/site";
  const origin = (
    await database
      .insert(feedOrigins)
      .values({
        feedId: feed.id,
        userId: "ingest-benchmark",
        kind: "atproto",
        locator: publication,
        sourceName: "Publication",
      })
      .returning()
  )[0]!;
  for (let start = 0; start < historySize; start += 100) {
    await database
      .insert(feedItems)
      .values(
        Array.from({ length: Math.min(100, historySize - start) }, (_, i) => ({
          feedId: feed.id,
          contentId: `old-${start + i}`,
          title: "Old item",
          author: "Author",
          url: `https://example.com/old/${start + i}`,
          postedAt: now,
        })),
      );
  }
  let revision = 1;
  let requests = 0;
  const remote: PublicationClient = {
    resolvePds: async () => "https://pds.example.com",
    latestRev: async () => {
      requests++;
      return `rev${revision}`;
    },
    getRecord: async () => {
      requests++;
      return {
        uri: publication,
        cid: "publication",
        value: { name: "Publication", url: "https://example.com" },
      };
    },
    loadBlob: async () => {
      throw new Error("Unexpected blob fetch");
    },
    resolveRecord: async () => null,
    list: async (_did, cursor) => {
      requests++;
      const offset = Number(cursor ?? 0);
      return {
        notModified: false,
        etag: null,
        cursor: offset === 0 ? "100" : undefined,
        records: Array.from({ length: 100 }, (_, i) => {
          const rkey = String(999 - offset - i);
          return {
            uri: `at://did:plc:benchmark/site.standard.document/${rkey}`,
            cid: `cid${revision}${rkey}`,
            value: {
              site: publication,
              title: `Article ${rkey} revision ${revision}`,
              path: `/${rkey}`,
              publishedAt: now.toISOString(),
              content: {
                $type: "pub.leaflet.content",
                pages: [
                  {
                    $type: "pub.leaflet.pages.linearDocument",
                    blocks: [
                      {
                        block: {
                          $type: "pub.leaflet.blocks.text",
                          plaintext: "Article body. ".repeat(100),
                        },
                      },
                    ],
                  },
                ],
              },
            },
          };
        }),
      };
    },
  };
  return {
    get requests() {
      return requests;
    },
    async run(changed: boolean) {
      if (changed) revision++;
      requests = 0;
      const currentOrigin = (await database
        .select()
        .from(feedOrigins)
        .where(eq(feedOrigins.id, origin.id))
        .get())!;
      return ingestAtmosphere(
        database,
        { feed, origin: currentOrigin },
        remote,
      );
    },
  };
}

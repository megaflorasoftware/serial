import { eq } from "drizzle-orm";
import type { BenchmarkDatabase } from "./database";
import type { StreamEvent } from "~/server/jetstream/protocol";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { feedItems, feedOriginAtproto, user } from "~/server/db/schema";
import { acceptBatch, ensureStream } from "~/server/jetstream/store";
import { processOriginDocuments } from "~/server/jetstream/process";

export async function createJetstreamWorkload(
  database: BenchmarkDatabase,
  fanout: number,
  history: number,
) {
  const service = "https://jetstream.benchmark.invalid";
  const did = "did:plc:benchmark";
  const uri = `at://${did}/site.standard.publication/site`;
  const now = new Date();
  const settings = {
    service,
    backgroundEnabled: true,
    now: () => now,
    getPlanId: async () => "pro" as const,
  };
  await ensureStream(database, service);
  const origins: number[] = [];
  let firstFeed = 0;
  for (let index = 0; index < fanout; index++) {
    const userId = `stream-benchmark-${index}`;
    await database
      .insert(user)
      .values({
        id: userId,
        name: userId,
        email: `${userId}@benchmark.invalid`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
      });
    const feed = await insertFeedWithOrigins(database, {
      userId,
      isActive: true,
      details: {
        name: "Publication",
        platform: "website",
        imageUrl: "",
        origins: [{ kind: "atproto", locator: uri }],
      },
    });
    firstFeed ||= feed.id;
    const originId = feed.origins[0]!.id;
    origins.push(originId);
    await database
      .update(feedOriginAtproto)
      .set({
        initialized: true,
        streamService: service,
        streamSeq: "1",
        streamMode: "live",
        publicationRecord: {
          uri,
          cid: "publication",
          value: { name: "Publication", url: "https://example.com" },
        },
      })
      .where(eq(feedOriginAtproto.originId, originId));
  }
  for (let offset = 0; offset < history; offset += 100)
    await database.insert(feedItems).values(
      Array.from({ length: Math.min(100, history - offset) }, (_, index) => ({
        id: `stream-history-${offset + index}`,
        feedId: firstFeed,
        contentId: `history-${offset + index}`,
        title: "Retained item",
        author: "",
        url: `https://example.com/old/${offset + index}`,
        postedAt: now,
      })),
    );
  let seq = 1;
  function event(): StreamEvent {
    return {
      seq,
      did,
      time: now.toISOString(),
      kind: "commit",
      commit: {
        operation: "update",
        collection: "site.standard.document",
        rkey: "post",
        rev: String(seq).padStart(13, "0"),
        cid: `cid-${seq}`,
        record: {
          $type: "site.standard.document",
          title: `Revision ${seq}`,
          site: uri,
          path: "/post",
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
                      plaintext: "Body",
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    };
  }
  return {
    origins,
    async run(mode: "changed" | "duplicate" | "ineligible" | "idle") {
      let publications = 0;
      if (mode !== "idle") {
        if (mode !== "duplicate") seq++;
        await acceptBatch(
          database,
          { events: [event()], lastCursor: seq },
          { ...settings, backgroundEnabled: mode !== "ineligible" },
        );
      }
      for (const originId of origins)
        await processOriginDocuments(database, originId, settings, {
          readPage: async () => {
            throw new Error("No optional image");
          },
          publish: async () => {
            publications++;
          },
        });
      return { publications };
    },
  };
}

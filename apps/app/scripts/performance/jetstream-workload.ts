import { eq } from "drizzle-orm";
import type { BenchmarkDatabase } from "./database";
import type { StreamEvent } from "~/server/jetstream/protocol";
import type { StreamTransport } from "~/server/jetstream/transport";
import type { PublicationClient } from "~/server/rss/atprotoClient";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  atprotoStreamState,
  feedItems,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  user,
} from "~/server/db/schema";
import { acceptBatch, ensureStream } from "~/server/jetstream/store";
import { recoverOrigin } from "~/server/jetstream/recovery";
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
    // Seed dependent user/origin identities in deterministic order.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await database.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@benchmark.invalid`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    });
    // The Feed references the user just inserted.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
    // The origin update depends on the generated Feed id.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
    // Bound fixture inserts to one batch in flight.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
    async recover(bootstrap: boolean) {
      seq++;
      const originId = origins[0]!;
      await database.update(atprotoStreamState).set({ seq: String(seq) });
      await database
        .update(feedOriginAtproto)
        .set({
          initialized: !bootstrap,
          streamMode: "direct",
          streamSeq: String(seq),
          cursor: null,
          boundary: null,
          newestRkey: null,
          initialCount: 0,
        })
        .where(eq(feedOriginAtproto.originId, originId));
      let pages = 0,
        images = 0,
        publications = 0;
      const transport: StreamTransport = {
        service,
        hasReplay: false,
        report: () => {},
        tip: async () => seq,
        async *stream() {},
        async *recover() {
          yield { events: [], lastCursor: seq };
        },
      };
      const remote: PublicationClient = {
        resolvePds: async () => "https://pds.example.com",
        getDidDocument: async () => {
          throw new Error("Unexpected DID document");
        },
        latestRev: async () => `rev${seq}`,
        getRecord: async () => ({
          uri,
          cid: "publication",
          value: { name: "Publication", url: "https://example.com" },
        }),
        loadBlob: async () => {
          throw new Error("Unexpected blob");
        },
        list: async (_did, cursor) => {
          pages++;
          const offset = Number(cursor ?? 0);
          return {
            notModified: false,
            etag: null,
            cursor: offset === 0 ? "100" : undefined,
            records: Array.from({ length: 100 }, (_, index) => {
              const key = String(999 - offset - index);
              const base = event();
              if (base.kind !== "commit") throw new Error();
              return {
                uri: `at://${did}/site.standard.document/${key}`,
                cid: `cid${seq}-${key}`,
                value: { ...(base.commit.record as object), path: `/${key}` },
              };
            }),
          };
        },
      };
      await recoverOrigin(
        database,
        originId,
        settings,
        transport,
        new AbortController().signal,
        {
          manual: true,
          client: remote,
          readPage: async () => {
            images++;
            throw new Error("No optional image");
          },
          publish: async () => {
            publications++;
          },
        },
      );
      return { pages, images, publications };
    },
    async prepareHealthy() {
      await database.update(atprotoStreamState).set({
        seq: String(seq),
        connected: true,
        leaseOwner: "benchmark",
        leaseUntil: new Date(now.getTime() + 60_000),
      });
      await database
        .update(feedOriginAtproto)
        .set({ streamMode: "live", streamGeneration: 0 });
      // Recovery samples leave staged work; a healthy idle check has none.
      await database
        .update(feedOriginAtprotoDocuments)
        .set({ status: "ready" });
    },
    async check() {
      const unexpected = () => {
        throw new Error("Healthy Feed fetched remote data");
      };
      const transport: StreamTransport = {
        service,
        hasReplay: false,
        report: unexpected,
        stream: unexpected,
        recover: unexpected,
        tip: unexpected,
      };
      await recoverOrigin(
        database,
        origins[0]!,
        settings,
        transport,
        new AbortController().signal,
        {
          manual: true,
          client: {
            resolvePds: unexpected,
            getDidDocument: unexpected,
            latestRev: unexpected,
            getRecord: unexpected,
            list: unexpected,
            loadBlob: unexpected,
          },
        },
      );
      return { requests: 0 };
    },
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
        // Measure one subscriber operation at a time against the same driver.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
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

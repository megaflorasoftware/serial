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
  feedOriginAtprotoDocumentSources,
  user,
} from "~/server/db/schema";
import { acceptBatch, ensureStream } from "~/server/jetstream/store";
import { recoverOrigin } from "~/server/jetstream/recovery";
import {
  drainDueOrigins,
  processOriginDocuments,
} from "~/server/jetstream/process";
import { startStreamIntake } from "~/server/jetstream/intake";
import { StreamFailure } from "~/server/jetstream/protocol";
import { forgetOutage, rememberOutage } from "~/server/jetstream/reachability";

/** A remote read the measured operation must not make. */
function forbidden(message: string) {
  return (): never => {
    throw new Error(message);
  };
}

/** A publication client that may make only the reads given. */
function clientReading(
  forbid: () => never,
  reads: Partial<PublicationClient> = {},
): PublicationClient {
  return {
    resolvePds: forbid,
    getDidDocument: forbid,
    latestRev: forbid,
    getRecord: forbid,
    list: forbid,
    loadBlob: forbid,
    ...reads,
  };
}

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
  // The same history as retained documents: each a readable version with its
  // source, all of one content type. Their keys sort below every listed one.
  for (let offset = 0; offset < history; offset += 500) {
    const versions = Array.from(
      { length: Math.min(500, history - offset) },
      (_, index) => ({
        originId: origins[0]!,
        uri: `at://${did}/site.standard.document/000-history-${offset + index}`,
        cid: `history-${offset + index}`,
      }),
    );
    // Bound fixture inserts to one batch in flight.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await database.insert(feedOriginAtprotoDocuments).values(
      versions.map((version) => ({
        ...version,
        status: "ready" as const,
        bodyCid: version.cid,
        bodyContentType: "pub.leaflet.content",
      })),
    );
    // Sources reference the documents just inserted.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await database.insert(feedOriginAtprotoDocumentSources).values(
      versions.map((version) => ({
        ...version,
        record: '{"content":{"$type":"pub.leaflet.content"}}',
        createdAt: now,
      })),
    );
  }
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
    /**
     * A recovery without replay of an origin whose repository still reads the
     * revision its last full listing saw. Only that revision is asked for.
     */
    async recoverUnchanged() {
      const originId = origins[0]!;
      await database
        .update(feedOriginAtproto)
        .set({ streamMode: "direct", streamSeq: String(seq) })
        .where(eq(feedOriginAtproto.originId, originId));
      let requests = 0;
      await recoverOrigin(
        database,
        originId,
        settings,
        {
          service,
          hasReplay: false,
          report: () => {},
          tip: async () => seq,
          async *stream() {},
          async *recover() {
            yield { events: [], lastCursor: seq };
          },
        },
        new AbortController().signal,
        {
          manual: true,
          client: clientReading(
            forbidden("An unmoved repository was read again"),
            {
              latestRev: async () => {
                requests++;
                return `rev${seq}`;
              },
            },
          ),
        },
      );
      return { requests };
    },
    /**
     * One fetch of an origin no worker covers while the stream host gives no
     * answer. A `remembered` fetch follows another that found the outage.
     */
    async outage(remembered: boolean) {
      const failure = new StreamFailure("connection");
      const unexpected = forbidden("A waiting origin read remote data");
      let contacts = 0;
      if (remembered) rememberOutage(service, failure, now.getTime());
      try {
        const outcome = await recoverOrigin(
          database,
          origins[0]!,
          settings,
          {
            service,
            hasReplay: false,
            report: () => {},
            stream: unexpected,
            recover: unexpected,
            tip: async () => {
              contacts++;
              throw failure;
            },
          },
          new AbortController().signal,
          {
            manual: true,
            client: clientReading(unexpected),
          },
        );
        return { outcome: outcome.status, contacts };
      } finally {
        forgetOutage(service);
      }
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
      await database
        .update(feedOriginAtproto)
        .set({ publicationDirty: false, stagedDueAt: null });
    },
    /**
     * Staged documents the sweep has no business reading: `count` waiting out
     * a backoff on a live origin, and `count` due on an origin the stream has
     * paused.
     */
    async stageBacklog(count: number) {
      const [, waiting, paused] = origins;
      if (!waiting || !paused) throw new Error("A backlog needs three origins");
      const retryAt = new Date(Date.now() + 60 * 60 * 1000);
      const staged = (originId: number, dueAt: Date | null) =>
        Array.from({ length: count }, (_, index) => ({
          originId,
          uri: `at://${did}/site.standard.document/backlog-${index}`,
          cid: `backlog-${index}`,
          status: "retry" as const,
          attempts: dueAt ? 5 : 0,
          retryAt: dueAt,
        }));
      const documents = [...staged(waiting, retryAt), ...staged(paused, null)];
      for (let offset = 0; offset < documents.length; offset += 500)
        // Bound fixture inserts to one batch in flight.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await database
          .insert(feedOriginAtprotoDocuments)
          .values(documents.slice(offset, offset + 500));
      await Promise.all([
        database
          .update(feedOriginAtproto)
          .set({ stagedDueAt: retryAt })
          .where(eq(feedOriginAtproto.originId, waiting)),
        database
          .update(feedOriginAtproto)
          .set({ stagedDueAt: new Date(0), streamMode: "paused" })
          .where(eq(feedOriginAtproto.originId, paused)),
      ]);
    },
    /** The worker's intake over this fixture, loaded before anything is measured. */
    async intake() {
      let applied = 0;
      const intake = await startStreamIntake({
        database,
        apply: async (events) => {
          applied += events.length;
        },
        distrust: async () => {
          throw new Error("A healthy intake distrusted an origin");
        },
      });
      return {
        /** One network event whose publisher nobody follows. */
        async skip() {
          seq++;
          await intake.accept({
            events: [{ ...event(), did: "did:plc:stranger" }],
            lastCursor: seq,
          });
          return { applied };
        },
        /** The heartbeat's look for origins created since the last one. */
        refresh: () => intake.refresh(),
      };
    },
    /** One retry sweep, as the instance holding the stream lease runs it. */
    async sweep() {
      let publications = 0;
      await drainDueOrigins(database, settings, {
        holdsLease: () => true,
        signal: new AbortController().signal,
        publish: async () => {
          publications++;
        },
      });
      return { publications };
    },
    async check() {
      const unexpected = forbidden("Healthy Feed fetched remote data");
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
          client: clientReading(unexpected),
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
          { events: [event()] },
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

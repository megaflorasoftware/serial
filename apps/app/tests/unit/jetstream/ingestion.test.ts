import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { StreamTransport } from "~/server/jetstream/transport";
import type { StreamSettings } from "~/server/jetstream/store";
import type { StreamEvent } from "~/server/jetstream/protocol";
import type { PublicationClient } from "~/server/rss/atprotoClient";
import { recordUserActivity } from "~/server/jetstream/activity";
import { recoverOrigin } from "~/server/jetstream/recovery";
import {
  CheckpointHostError,
  StreamFailure,
} from "~/server/jetstream/protocol";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  acceptBatch,
  connectStream,
  declareStreamGap,
  disconnectStream,
  distrustOriginCoverage,
  ensureStream,
  holdStream,
  saveCheckpoint,
  stageDocument,
} from "~/server/jetstream/store";
import {
  drainDueOrigins,
  drainOriginDocuments,
  originsWithDueWork,
  processOriginDocuments,
} from "~/server/jetstream/process";
import {
  atprotoStreamState,
  feedItems,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feedOriginAtprotoDocumentSources,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { captureRecordValue } from "~/server/jetstream/document-source";
import { runDatabaseWrite } from "~/server/db/retry-write";

vi.mock("~/server/logger", () => ({
  captureException: vi.fn(),
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("~/lib/constants", () => ({ IS_MAIN_INSTANCE: true }));
vi.mock("~/lib/demo", () => ({ IS_DEMO_INSTANCE: false }));
const NOW = new Date("2026-09-18T12:00:00Z");
const SERVICE = "https://jetstream.example.com";
const DID = "did:plc:alice";
const PUB = `at://${DID}/site.standard.publication/site`;
const uri = (key: string) => `at://${DID}/site.standard.document/${key}`;
const publication = {
  uri: PUB,
  cid: "pubcid",
  value: { name: "Publication", url: "https://example.com" },
};
const settings: StreamSettings = {
  service: SERVICE,
  backgroundEnabled: true,
  now: () => NOW,
  getPlanId: async () => "free",
};
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let originId: number;
let feedId: number;
const readPage = async () => {
  throw new Error("Optional image unavailable");
};
const client: PublicationClient = {
  resolvePds: vi.fn(async () => "https://pds.example.com"),
  getDidDocument: vi.fn(async () => {
    throw new Error("Unexpected DID document");
  }),
  latestRev: vi.fn(async () => "rev"),
  getRecord: vi.fn(async () => publication),
  loadBlob: vi.fn(async () => ({ bytes: new Uint8Array(), mimeType: null })),
  list: vi.fn(async () => ({
    records: [],
    notModified: false as const,
    cursor: undefined,
    etag: null,
  })),
};
function event(
  seq: number,
  key = "post",
  title = "Title",
  operation: "create" | "update" | "delete" = "create",
): StreamEvent {
  return {
    seq,
    did: DID,
    time: NOW.toISOString(),
    kind: "commit",
    commit: {
      operation,
      collection: "site.standard.document",
      rkey: key,
      rev: String(seq).padStart(13, "0"),
      cid: `cid${seq}`,
      ...(operation === "delete"
        ? {}
        : {
            record: {
              $type: "site.standard.document",
              site: PUB,
              title,
              path: `/${key}`,
              publishedAt: NOW.toISOString(),
              content: {
                $type: "pub.leaflet.content",
                pages: [
                  {
                    $type: "pub.leaflet.pages.linearDocument",
                    blocks: [
                      {
                        block: {
                          $type: "pub.leaflet.blocks.text",
                          plaintext: title,
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
    },
  };
}
async function addReader(id: string, active: Date | null = NOW) {
  await fixture.database.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastActiveAt: active,
  });
  const feed = await insertFeedWithOrigins(fixture.database, {
    userId: id,
    isActive: true,
    details: {
      name: "Feed",
      platform: "website",
      imageUrl: "",
      origins: [{ kind: "atproto", locator: PUB }],
    },
  });
  const origin = feed.origins[0]!;
  await fixture.database
    .update(feedOriginAtproto)
    .set({
      initialized: true,
      streamService: SERVICE,
      streamSeq: "1",
      streamMode: "live",
      publicationRecord: publication,
    })
    .where(eq(feedOriginAtproto.originId, origin.id));
  return { feedId: feed.id, originId: origin.id };
}
/** Applies events, then saves progress the way the worker's heartbeat does. */
async function accept(...events: StreamEvent[]) {
  await acceptBatch(fixture.database, { events }, settings);
  await holdStream(fixture.database, "worker", NOW, events.at(-1)!.seq);
}
async function process(id = originId) {
  await processOriginDocuments(fixture.database, id, settings, {
    client,
    readPage,
  });
}
async function state(id = originId) {
  return (await fixture.database
    .select()
    .from(feedOriginAtproto)
    .where(eq(feedOriginAtproto.originId, id))
    .get())!;
}
/** Retained source rows for one document, newest staging last. */
async function sources(documentUri: string) {
  return fixture.database
    .select()
    .from(feedOriginAtprotoDocumentSources)
    .where(eq(feedOriginAtprotoDocumentSources.uri, documentUri))
    .orderBy(feedOriginAtprotoDocumentSources.cid);
}
async function ledger(documentUri: string) {
  return fixture.database
    .select()
    .from(feedOriginAtprotoDocuments)
    .where(eq(feedOriginAtprotoDocuments.uri, documentUri))
    .get();
}
beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createBookmarkTestDatabase();
  await ensureStream(fixture.database, SERVICE);
  ({ originId, feedId } = await addReader("reader"));
});
afterEach(() => fixture.cleanup());

describe("durable Jetstream application", () => {
  it("applies creates and older edits once while preserving reader state across restart/replay", async () => {
    await accept(event(10));
    await process();
    const item = (await fixture.database.select().from(feedItems))[0]!;
    await fixture.database
      .update(feedItems)
      .set({ isWatchLater: true, isWatched: true, progress: 72 })
      .where(eq(feedItems.id, item.id));
    await accept(event(11, "post", "Edited", "update"));
    await process();
    await accept(event(11, "post", "Edited", "update"));
    await process();
    const items = await fixture.database.select().from(feedItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: item.id,
      title: "Edited",
      isWatchLater: true,
      isWatched: true,
      progress: 72,
    });
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0]?.seq,
    ).toBe("11");
  });
  it("durably stages input before checkpointing and finishes it after worker restart", async () => {
    await accept(event(10));
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0],
    ).toMatchObject({ status: "retry", eventSeq: "10" });
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0]?.seq,
    ).toBe("10");
    await process();
    // The body is the retained source, named on the item and on the ledger.
    expect(await fixture.database.select().from(feedItems)).toMatchObject([
      { content: "", sourceCid: "cid10", bodySource: "atproto" },
    ]);
    expect(await ledger(uri("post"))).toMatchObject({
      status: "ready",
      bodyCid: "cid10",
      // The readable version's content type, which decides the Feed's platform.
      bodyContentType: "pub.leaflet.content",
      reason: null,
    });
    expect(await sources(uri("post"))).toMatchObject([{ cid: "cid10" }]);
  });
  it("retains reader copies on delete and prevents a stale replay from recreating pending work", async () => {
    await accept(event(10));
    await process();
    await accept(event(12, "post", "", "delete"));
    await acceptBatch(
      fixture.database,
      { events: [event(11, "post", "stale")] },
      settings,
      { originId },
    );
    await process();
    expect((await fixture.database.select().from(feedItems))[0]?.title).toBe(
      "Title",
    );
    // The deleted document keeps its readable version and that version's type.
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0],
    ).toMatchObject({
      status: "deleted",
      bodyCid: "cid10",
      bodyContentType: "pub.leaflet.content",
    });
  });
  it("rejects a conversion overtaken by a delete", async () => {
    await accept(event(10));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = processOriginDocuments(fixture.database, originId, settings, {
      client,
      readPage: async () => {
        started();
        await blocked;
        throw new Error("No image");
      },
    });
    await entered;
    await accept(event(11, "post", "", "delete"));
    release();
    await work;
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
  });
  it("isolates an inactive reader of the same Publication and preserves their catch-up position", async () => {
    const inactive = await addReader(
      "inactive",
      new Date(NOW.getTime() - 8 * 86_400_000),
    );
    await accept(event(10));
    await process();
    await process(inactive.originId);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
    expect(await state(inactive.originId)).toMatchObject({
      streamSeq: "1",
      streamMode: "paused",
    });
    expect(
      await fixture.database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.originId, inactive.originId)),
    ).toHaveLength(0);
  });
  it("does not advance a per-user catch-up cursor past gaps when live events arrive", async () => {
    await fixture.database
      .update(feedOriginAtproto)
      .set({ streamMode: "catchup" })
      .where(eq(feedOriginAtproto.originId, originId));
    await accept(event(12));
    expect((await state()).streamSeq).toBe("1");
    await acceptBatch(
      fixture.database,
      { events: [event(10, "old", "Missed")] },
      settings,
      { originId },
    );
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(2);
  });
  it("rechecks active Feed and activity eligibility at the write boundary", async () => {
    await accept(event(10));
    await fixture.database
      .update(feeds)
      .set({ isActive: false })
      .where(eq(feeds.id, feedId));
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
  });
  it("records invalid documents without blocking other documents or global progress", async () => {
    const invalid = event(10);
    if (invalid.kind === "commit") invalid.commit.record = { broken: true };
    await accept(invalid, event(11, "valid"));
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0]?.seq,
    ).toBe("11");
    expect(
      (
        await fixture.database
          .select()
          .from(feedOriginAtprotoDocuments)
          .where(eq(feedOriginAtprotoDocuments.uri, uri("post")))
          .get()
      )?.status,
    ).toBe("invalid");
  });
  it("handles identity, account and sync markers while retaining reader content", async () => {
    await accept(event(10));
    await process();
    await accept({
      seq: 11,
      did: DID,
      time: NOW.toISOString(),
      kind: "identity",
      identity: {},
    });
    await accept({
      seq: 12,
      did: DID,
      time: NOW.toISOString(),
      kind: "sync",
      sync: { rev: "0000000000012" },
    });
    await accept({
      seq: 13,
      did: DID,
      time: NOW.toISOString(),
      kind: "account",
      account: { active: false },
    });
    expect(await state()).toMatchObject({
      identitySeq: "11",
      repositorySeq: "12",
      accountSeq: "13",
      repositoryActive: false,
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("refuses a checkpoint from another normalized service", async () => {
    expect((await ensureStream(fixture.database, SERVICE + "/")).service).toBe(
      SERVICE,
    );
    await expect(
      ensureStream(fixture.database, "https://other.example.com"),
    ).rejects.toBeInstanceOf(CheckpointHostError);
  });
  it("keeps sequences above 32 bits exact", async () => {
    await accept(event(9_007_199_254_740_990));
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0]?.seq,
    ).toBe("9007199254740990");
  });
  it("does not let bootstrap staging replace a concurrent stream version", async () => {
    await accept(event(12, "post", "Live"));
    await runDatabaseWrite(fixture.database, () =>
      fixture.database.transaction(async (tx) => {
        const bootstrap = event(1);
        if (bootstrap.kind !== "commit") throw new Error();
        await stageDocument(tx, {
          originId,
          uri: uri("post"),
          cid: "old",
          record: captureRecordValue(bootstrap.commit.record),
          seq: 1,
        });
      }),
    );
    await process();
    expect((await fixture.database.select().from(feedItems))[0]?.title).toBe(
      "Live",
    );
  });
});

function replay(
  events: StreamEvent[],
  through: number,
  failure?: Error,
): StreamTransport {
  return {
    service: SERVICE,
    hasReplay: true,
    report: vi.fn(),
    tip: vi.fn(async () => through),
    async *stream() {},
    async *recover(after) {
      for (const event of events.filter((event) => event.seq > after))
        yield { events: [event], lastCursor: event.seq };
      if (failure) throw failure;
      yield { events: [], lastCursor: through };
    },
  };
}
/** Replays only the interval asked for, as the real transport does, up to a live tip. */
function replayWithin(events: StreamEvent[], tip: number): StreamTransport {
  return {
    ...replay([], tip),
    async *recover(after, through) {
      for (const missed of events.filter(
        (candidate) => candidate.seq > after && candidate.seq <= through,
      ))
        yield { events: [missed], lastCursor: missed.seq };
      yield { events: [], lastCursor: through };
    },
  };
}
async function pause(through: number) {
  await fixture.database
    .update(feedOriginAtproto)
    .set({ streamMode: "paused" })
    .where(eq(feedOriginAtproto.originId, originId));
  await fixture.database
    .update(atprotoStreamState)
    .set({ seq: String(through) });
}
describe("Feed recovery", () => {
  it("resumes partial archive work after a download failure without claiming the rest", async () => {
    await pause(20);
    await expect(
      recoverOrigin(
        fixture.database,
        originId,
        settings,
        replay([event(10)], 20, new StreamFailure("download", 503)),
        new AbortController().signal,
        { client, readPage },
      ),
    ).rejects.toThrow();
    expect(await state()).toMatchObject({
      streamSeq: "10",
      streamMode: "catchup",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
    await fixture.database
      .update(feedOriginAtproto)
      .set({ recoveryRetryAt: null });
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      replay([event(11, "next")], 20),
      new AbortController().signal,
      { client, readPage },
    );
    expect(await state()).toMatchObject({
      streamSeq: "20",
      streamMode: "live",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
  });
  it("covers more than 200 missed documents without truncating the interval", async () => {
    await pause(300);
    const events = Array.from({ length: 205 }, (_, index) =>
      event(index + 2, `post-${index}`),
    );
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      replay(events, 300),
      new AbortController().signal,
      { client, readPage },
    );
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(205);
    expect(await state()).toMatchObject({
      streamSeq: "300",
      streamMode: "live",
    });
    // Application remains bounded even when the recovered interval is large.
    expect(await fixture.database.select().from(feedItems)).toHaveLength(25);
    // The rest is left for the retry sweep, which finds the origin now live.
    expect(await originsWithDueWork(fixture.database, NOW)).toEqual([originId]);
  }, 30_000);
  it("drains every staged document for an explicit fetch and one page otherwise", async () => {
    await pause(300);
    const events = Array.from({ length: 60 }, (_, index) =>
      event(index + 2, `post-${index}`),
    );
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      replay(events, 300),
      new AbortController().signal,
      { client, readPage, drain: true },
    );
    expect(await fixture.database.select().from(feedItems)).toHaveLength(60);
    // A complete drain leaves the retry sweep nothing to find.
    expect(await originsWithDueWork(fixture.database, NOW)).toEqual([]);
    expect(
      await fixture.database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.status, "retry")),
    ).toHaveLength(0);
    const more = Array.from({ length: 30 }, (_, index) =>
      event(index + 400, `later-${index}`),
    );
    await accept(...more);
    await drainOriginDocuments(fixture.database, originId, settings, {
      client,
      readPage,
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(85);
    // A pass that makes no progress, here an origin that is no longer initialized, ends the drain.
    await fixture.database
      .update(feedOriginAtproto)
      .set({ initialized: false })
      .where(eq(feedOriginAtproto.originId, originId));
    await drainOriginDocuments(fixture.database, originId, settings, {
      client,
      readPage,
      drain: true,
    });
    expect(
      await fixture.database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.status, "retry")),
    ).toHaveLength(5);
    // The first page always runs, so a drain also applies a changed Publication.
    await fixture.database
      .update(feedOriginAtproto)
      .set({
        initialized: true,
        publicationRecord: {
          uri: PUB,
          cid: "pubcid2",
          value: {
            $type: "site.standard.publication",
            name: "Renamed",
            url: "https://example.com",
          },
        },
        publicationDirty: true,
      })
      .where(eq(feedOriginAtproto.originId, originId));
    await drainOriginDocuments(fixture.database, originId, settings, {
      client,
      readPage,
      drain: true,
    });
    expect((await fixture.database.select().from(feeds).get())?.name).toBe(
      "Renamed",
    );
    expect(await fixture.database.select().from(feedItems)).toHaveLength(90);
  }, 30_000);
  it("does no writes for a sweep of an ineligible user's Feed", async () => {
    await fixture.database.update(user).set({ lastActiveAt: null });
    const before = await state();
    const writes = vi.spyOn(fixture.database, "update");
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      replay([], 20),
      new AbortController().signal,
      { client, readPage },
    );
    expect(writes).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
  it("uses a bounded repository fetch for no-key gaps without probing cursor expiry", async () => {
    await pause(20);
    const transport = {
      ...replay([event(21)], 22),
      hasReplay: false,
      tip: vi.fn().mockResolvedValueOnce(20).mockResolvedValue(22),
    };
    const list = vi.mocked(client.list);
    list.mockClear();
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client, readPage },
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(await state()).toMatchObject({
      streamSeq: "22",
      streamMode: "live",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("uses direct recovery for a no-key gap and then covers concurrent changes", async () => {
    await pause(20);
    const transport: StreamTransport = {
      ...replay([], 30),
      hasReplay: false,
      async *recover() {
        yield { events: [event(30)], lastCursor: 30 };
      },
    };
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client, readPage },
    );
    expect(client.list).toHaveBeenCalled();
    expect(await state()).toMatchObject({
      streamSeq: "30",
      streamMode: "live",
    });
  });
  it("bootstraps a no-key origin from a connected worker's checkpoint without reading the tip", async () => {
    await fixture.database.update(atprotoStreamState).set({
      seq: "20",
      connected: true,
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
    await fixture.database.update(feedOriginAtproto).set({
      initialized: false,
      streamMode: "paused",
      streamSeq: null,
      streamService: null,
    });
    const transport = { ...replay([], 20), hasReplay: false };
    const recover = vi.spyOn(transport, "recover");
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client, readPage },
    );
    expect(transport.tip).not.toHaveBeenCalled();
    // An empty interval never opens a connection.
    expect(
      recover.mock.calls.map(([after, through]) => [after, through]),
    ).toEqual([[20, 20]]);
    expect(await state()).toMatchObject({
      initialized: true,
      streamSeq: "20",
      streamMode: "live",
    });
  });
  it("reads the tip for a no-key bootstrap when no worker is connected", async () => {
    await fixture.database.update(atprotoStreamState).set({
      seq: "20",
      connected: false,
    });
    await fixture.database.update(feedOriginAtproto).set({
      initialized: false,
      streamMode: "paused",
      streamSeq: null,
      streamService: null,
    });
    const transport = {
      ...replay([event(21)], 22),
      hasReplay: false,
      tip: vi.fn().mockResolvedValueOnce(20).mockResolvedValue(22),
    };
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client, readPage },
    );
    expect(transport.tip).toHaveBeenCalledTimes(2);
    expect(await state()).toMatchObject({
      streamSeq: "22",
      streamMode: "live",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("catches up past a frozen checkpoint when replay is available but no worker is connected", async () => {
    await pause(1);
    await fixture.database.update(atprotoStreamState).set({ connected: false });
    const transport = {
      ...replay([event(20, "missed")], 30),
      hasReplay: true,
      tip: vi.fn(async () => 30),
    };
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client, readPage, manual: true },
    );
    expect(transport.tip).toHaveBeenCalled();
    expect(await state()).toMatchObject({
      streamSeq: "30",
      streamMode: "live",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("explicit refresh recovers when background ingestion is disabled", async () => {
    await fixture.database.update(atprotoStreamState).set({ seq: "20" });
    await recoverOrigin(
      fixture.database,
      originId,
      { ...settings, backgroundEnabled: false },
      replay([event(10)], 20),
      new AbortController().signal,
      { client, readPage, manual: true },
    );
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
});

describe("failure isolation", () => {
  it("retains a 64-bit integer field with its digits intact", async () => {
    const commit = event(10);
    if (commit.kind !== "commit") throw new Error();
    // The wire text carries a value no double can hold; the parsed record rounds.
    const text = JSON.stringify({
      ...(commit.commit.record as object),
      views: 0,
    }).replace('"views":0', '"views":9007199254740993');
    commit.commit.record = JSON.parse(text);
    commit.commit.recordText = text;
    await accept(commit);
    await process();
    expect((await sources(uri("post")))[0]?.record).toContain(
      '"views":9007199254740993',
    );
    expect(await fixture.database.select().from(feedItems)).toMatchObject([
      { sourceCid: "cid10" },
    ]);
  });
  it("reads the record itself when its staged source row is gone", async () => {
    await accept(event(10));
    await fixture.database.delete(feedOriginAtprotoDocumentSources);
    const fetched = vi.fn(async () => {
      const staged = event(10);
      if (staged.kind !== "commit") throw new Error();
      return { uri: uri("post"), cid: "cid10", value: staged.commit.record };
    });
    await processOriginDocuments(fixture.database, originId, settings, {
      client: { ...client, getRecord: fetched },
      readPage,
    });
    expect(fetched).toHaveBeenCalledWith(uri("post"), { cid: "cid10" });
    expect(await ledger(uri("post"))).toMatchObject({
      status: "ready",
      bodyCid: "cid10",
    });
    // The retained source is the record value, not the lookup envelope.
    expect((await sources(uri("post")))[0]?.record).toMatch(/^\{"\$type"/);
    expect(await fixture.database.select().from(feedItems)).toMatchObject([
      { sourceCid: "cid10" },
    ]);
  });
  it("stores publication records as plain JSON even when the wire carried big integers", async () => {
    const commit = event(10);
    if (commit.kind !== "commit") throw new Error();
    const record = {
      $type: "site.standard.publication",
      name: "Publication",
      url: "https://example.com",
      subscribers: 9007199254740993n,
    };
    await accept({
      ...commit,
      commit: {
        ...commit.commit,
        collection: "site.standard.publication",
        rkey: "site",
        record,
        recordText: '{"subscribers":9007199254740993}',
      },
    });
    expect((await state()).publicationRecord).toMatchObject({
      value: { name: "Publication", subscribers: 9007199254740992 },
    });
  });
  it("keeps the last readable version when a newer one fails the adapter", async () => {
    await accept(event(10));
    await process();
    const broken = event(11, "post", "Broken", "update");
    if (broken.kind !== "commit") throw new Error();
    (broken.commit.record as { content: unknown }).content = {
      $type: "app.offprint.content",
      items: "nope",
    };
    await accept(broken);
    await process();
    // The failure is noted on the ledger; the newer metadata still lands.
    expect(await ledger(uri("post"))).toMatchObject({
      cid: "cid11",
      status: "ready",
      reason: "adapter",
      bodyCid: "cid10",
      // The failed version's type does not replace the readable one's.
      bodyContentType: "pub.leaflet.content",
    });
    // The readable version and the body it produced both survive the failure.
    expect(await sources(uri("post"))).toMatchObject([{ cid: "cid10" }]);
    expect(await fixture.database.select().from(feedItems)).toMatchObject([
      { title: "Broken", sourceCid: "cid10" },
    ]);
  });
  it("refuses to stage a record larger than the source budget", async () => {
    const huge = event(10);
    if (huge.kind !== "commit") throw new Error();
    (huge.commit.record as { title: string }).title = "x".repeat(4_200_000);
    await accept(huge);
    expect(await ledger(uri("post"))).toMatchObject({
      status: "invalid",
      reason: "oversized",
      bodyCid: null,
      bodyContentType: null,
    });
    expect(await sources(uri("post"))).toEqual([]);
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
  });
  it("keeps other documents when a required body conversion fails", async () => {
    const broken = event(10, "broken");
    if (broken.kind !== "commit") throw new Error();
    broken.commit.record = {
      $type: "site.standard.document",
      site: PUB,
      title: "Broken",
      path: "/broken",
      publishedAt: NOW.toISOString(),
      content: {
        $type: "pub.leaflet.content",
        blobPages: { ref: { $link: "bafybody" } },
      },
    };
    await accept(broken, event(11, "good"));
    await processOriginDocuments(fixture.database, originId, settings, {
      client: {
        ...client,
        loadBlob: async () => {
          throw new Error("Required body unavailable");
        },
      },
      readPage,
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
    const pending = await fixture.database
      .select()
      .from(feedOriginAtprotoDocuments)
      .where(eq(feedOriginAtprotoDocuments.uri, uri("broken")))
      .get();
    expect(pending).toMatchObject({ status: "retry", attempts: 1 });
    // The staged source survives the transient failure so the retry can read it.
    expect(await sources(uri("broken"))).toMatchObject([
      { cid: "cid10", record: expect.stringContaining("Broken") },
    ]);
  });
  it("rolls back an item write if recording document completion fails", async () => {
    await accept(event(10));
    await fixture.client.execute(
      `CREATE TRIGGER fail_completion BEFORE UPDATE ON serial_feed_origin_atproto_document WHEN NEW.status = 'ready' BEGIN SELECT RAISE(ABORT, 'crash'); END`,
    );
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0]
        ?.status,
    ).toBe("retry");
    await fixture.client.execute("DROP TRIGGER fail_completion");
    await fixture.database
      .update(feedOriginAtprotoDocuments)
      .set({ retryAt: null });
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("does not checkpoint work that could not be durably staged", async () => {
    await fixture.client.execute(
      `CREATE TRIGGER fail_staging BEFORE INSERT ON serial_feed_origin_atproto_document BEGIN SELECT RAISE(ABORT, 'crash'); END`,
    );
    await expect(accept(event(10))).rejects.toThrow();
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0]?.seq,
    ).toBeNull();
    expect((await state()).streamSeq).toBe("1");
  });
  it("retains a saved Feed when its initial recovery boundary is unavailable", async () => {
    await fixture.database.update(feedOriginAtproto).set({
      initialized: false,
      streamMode: "paused",
      streamSeq: null,
      streamService: null,
    });
    await expect(
      recoverOrigin(
        fixture.database,
        originId,
        settings,
        replay([], 10),
        new AbortController().signal,
        { client, readPage },
      ),
    ).rejects.toThrow("boundary");
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
  });
  it("queues only the newest 100 initial documents and applies concurrent edits before rendering", async () => {
    await fixture.database.update(atprotoStreamState).set({ seq: "1" });
    await fixture.database.update(feedOriginAtproto).set({
      initialized: false,
      streamMode: "paused",
      streamSeq: null,
      streamService: null,
    });
    const remote: PublicationClient = {
      ...client,
      list: vi.fn(async (_did, cursor) => ({
        records: Array.from({ length: 100 }, (_, index) => {
          const key = String(999 - Number(cursor ?? 0) - index);
          const value = event(1, key);
          if (value.kind !== "commit") throw new Error();
          return { uri: uri(key), cid: "initial", value: value.commit.record };
        }),
        notModified: false as const,
        cursor: String(Number(cursor ?? 0) + 100),
        etag: null,
      })),
    };
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      replay([event(2, "999", "Latest")], 3),
      new AbortController().signal,
      { client: remote, readPage },
    );
    expect(remote.list).toHaveBeenCalledTimes(1);
    const staged = await fixture.database
      .select({ uri: feedOriginAtprotoDocuments.uri })
      .from(feedOriginAtprotoDocuments);
    expect(staged).toHaveLength(100);
    expect(staged.map((row) => row.uri)).toContain(uri("999"));
    expect(staged.map((row) => row.uri)).not.toContain(uri("899"));
    expect(
      (
        await fixture.database
          .select()
          .from(feedItems)
          .where(eq(feedItems.atprotoUri, uri("999")))
          .get()
      )?.title,
    ).toBe("Latest");
    // One page was imported; the sweep finds the origin for the rest.
    expect(await originsWithDueWork(fixture.database, NOW)).toEqual([originId]);
  }, 15_000);
});

describe("marker ordering", () => {
  const marker = (seq: number, kind: "account" | "sync"): StreamEvent =>
    kind === "account"
      ? {
          seq,
          did: DID,
          time: NOW.toISOString(),
          kind,
          account: { active: false, status: "deleted" },
        }
      : {
          seq,
          did: DID,
          time: NOW.toISOString(),
          kind,
          sync: { rev: String(seq).padStart(13, "0") },
        };
  it("retains a newer document when an older Publication delete is replayed", async () => {
    await accept(event(30));
    const deletion = event(20, "site", "", "delete");
    if (deletion.kind !== "commit") throw new Error();
    deletion.commit.collection = "site.standard.publication";
    await acceptBatch(fixture.database, { events: [deletion] }, settings, {
      originId,
    });
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0],
    ).toMatchObject({ eventSeq: "30", status: "retry" });
  });
  it("orders account and sync state independently during replay", async () => {
    await accept(event(30));
    await acceptBatch(
      fixture.database,
      { events: [marker(25, "sync"), marker(20, "account")] },
      settings,
      { originId },
    );
    expect(await state()).toMatchObject({
      accountSeq: "20",
      repositorySeq: "25",
      repositoryActive: false,
    });
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0],
    ).toMatchObject({ eventSeq: "30", status: "retry" });
  });
  it("does not resurrect unknown documents from before an account deletion", async () => {
    const deletion: StreamEvent = {
      seq: 20,
      did: DID,
      time: NOW.toISOString(),
      kind: "account",
      account: { active: false, status: "deleted" },
    };
    await accept(deletion);
    await acceptBatch(fixture.database, { events: [event(10)] }, settings, {
      originId,
    });
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(0);
  });
  it("preserves pending work through temporary account deactivation", async () => {
    await accept(event(10));
    const inactive = marker(11, "account");
    if (inactive.kind !== "account") throw new Error();
    inactive.account.status = "deactivated";
    await accept(inactive);
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
    await accept({ ...inactive, seq: 12, account: { active: true } });
    await process();
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("honors replay Retry-After across attempts", async () => {
    await pause(20);
    const transport = replay(
      [],
      20,
      new StreamFailure("rate-limit", 429, 120_000),
    );
    await expect(
      recoverOrigin(
        fixture.database,
        originId,
        settings,
        transport,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect((await state()).recoveryRetryAt).toEqual(
      new Date(NOW.getTime() + 120_000),
    );
    const recovered = replay([], 20);
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      recovered,
      new AbortController().signal,
    );
    expect((await state()).streamMode).toBe("catchup");
  });
  it("rejects bootstrap results after another worker takes its lease", async () => {
    await fixture.database.update(atprotoStreamState).set({ seq: "1" });
    await fixture.database
      .update(feedOriginAtproto)
      .set({ initialized: false, streamMode: "paused", streamSeq: null });
    const remote: PublicationClient = {
      ...client,
      list: async () => {
        await fixture.database
          .update(feedOriginAtproto)
          .set({ workOwner: "replacement" });
        const post = event(1);
        if (post.kind !== "commit") throw new Error();
        return {
          records: [
            { uri: uri("post"), cid: "initial", value: post.commit.record },
          ],
          notModified: false as const,
          etag: null,
        };
      },
    };
    await expect(
      recoverOrigin(
        fixture.database,
        originId,
        settings,
        replay([], 10),
        new AbortController().signal,
        { client: remote },
      ),
    ).rejects.toThrow();
    expect(await state()).toMatchObject({
      initialized: false,
      workOwner: "replacement",
    });
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(0);
  });
});

describe("recovery review regressions", () => {
  it("finishes a no-key repository scan across bounded attempts", async () => {
    await pause(20);
    const transport: StreamTransport = {
      ...replay([], 30),
      hasReplay: false,
      async *recover() {
        yield { events: [], lastCursor: 30 };
      },
    };
    const remote: PublicationClient = {
      ...client,
      list: async (_did, cursor) => {
        const offset = Number(cursor ?? 0);
        return {
          notModified: false as const,
          etag: null,
          cursor: offset + 100 < 450 ? String(offset + 100) : undefined,
          records: Array.from(
            { length: Math.min(100, 450 - offset) },
            (_, index) => {
              const key = String(999 - offset - index);
              const post = event(1, key);
              if (post.kind !== "commit") throw new Error();
              return {
                uri: uri(key),
                cid: "initial",
                value: post.commit.record,
              };
            },
          ),
        };
      },
    };
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client: remote, readPage },
    );
    expect((await state()).streamMode).toBe("direct");
    expect((await state()).cursor).toBeTruthy();
    for (
      let index = 0;
      index < 6 && (await state()).streamMode !== "live";
      index++
    )
      await recoverOrigin(
        fixture.database,
        originId,
        settings,
        transport,
        new AbortController().signal,
        { client: remote, readPage },
      );
    expect((await state()).streamMode).toBe("live");
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(450);
  }, 30000);
  it("retries direct recovery after failure before the first repository page", async () => {
    await pause(20);
    const transport: StreamTransport = {
      ...replay([], 30),
      hasReplay: false,
      async *recover() {
        yield { events: [], lastCursor: 30 };
      },
    };
    const latestRev = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue("rev");
    const list = vi.fn(client.list);
    await expect(
      recoverOrigin(
        fixture.database,
        originId,
        settings,
        transport,
        new AbortController().signal,
        { client: { ...client, latestRev, list }, readPage },
      ),
    ).rejects.toThrow("Offline");
    expect((await state()).streamMode).toBe("direct");
    await fixture.database
      .update(feedOriginAtproto)
      .set({ recoveryRetryAt: null });
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client: { ...client, latestRev, list }, readPage },
    );
    expect(list).toHaveBeenCalled();
    expect((await state()).streamMode).toBe("live");
  });
  it("rejects a conversion after its admin reader loses eligibility", async () => {
    await fixture.database
      .update(user)
      .set({ role: "admin", lastActiveAt: null });
    await accept(event(10));
    await processOriginDocuments(fixture.database, originId, settings, {
      client,
      readPage: async () => {
        await fixture.database.update(user).set({ role: "user" });
        throw new Error("No optional image");
      },
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
  });
});

it("coalesces nearby activity writes and records later use without touching another user", async () => {
  await fixture.database.update(user).set({ lastActiveAt: null });
  await fixture.database.insert(user).values({
    id: "other",
    name: "Other",
    email: "other@example.com",
    emailVerified: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await recordUserActivity(fixture.database, "reader", NOW);
  await recordUserActivity(
    fixture.database,
    "reader",
    new Date(NOW.getTime() + 299_999),
  );
  expect(
    (await fixture.database
      .select()
      .from(user)
      .where(eq(user.id, "reader"))
      .get())!.lastActiveAt,
  ).toEqual(NOW);
  const later = new Date(NOW.getTime() + 300_000);
  await recordUserActivity(fixture.database, "reader", later);
  expect(
    (await fixture.database
      .select()
      .from(user)
      .where(eq(user.id, "reader"))
      .get())!.lastActiveAt,
  ).toEqual(later);
  expect(
    (await fixture.database
      .select()
      .from(user)
      .where(eq(user.id, "other"))
      .get())!.lastActiveAt,
  ).toBeNull();
});

it("falls back on the first manual refresh after a no-key outage with background work disabled", async () => {
  await fixture.database.update(atprotoStreamState).set({ seq: "1" });
  let attempts = 0;
  const transport: StreamTransport = {
    ...replay([], 30),
    hasReplay: false,
    async *recover(after, through) {
      if (after < through && attempts++ === 0)
        throw new StreamFailure("cursor-expired", 400);
      yield { events: [], lastCursor: through };
    },
  };
  const list = vi.fn(client.list);
  await recoverOrigin(
    fixture.database,
    originId,
    { ...settings, backgroundEnabled: false },
    transport,
    new AbortController().signal,
    { manual: true, client: { ...client, list }, readPage },
  );
  expect(list).toHaveBeenCalled();
  expect((await state()).streamMode).toBe("live");
});

describe("normal fetch recovery after stream interruptions", () => {
  it.each([true, false])(
    "skips reconciliation for a healthy stream, archive=%s",
    async (hasReplay) => {
      await fixture.database.update(atprotoStreamState).set({
        seq: "20",
        connected: true,
        leaseUntil: new Date(NOW.getTime() + 60_000),
      });
      const transport = { ...replay([], 20), hasReplay };
      const recover = vi.spyOn(transport, "recover");
      const list = vi.fn(client.list);
      await recoverOrigin(
        fixture.database,
        originId,
        settings,
        transport,
        new AbortController().signal,
        { manual: true, client: { ...client, list }, readPage },
      );
      expect(recover).not.toHaveBeenCalled();
      expect(transport.tip).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("records a gap without updating Feeds, and preserves the pre-gap archive cursor as live events arrive", async () => {
    await fixture.database.update(atprotoStreamState).set({
      seq: "1",
      leaseOwner: "worker",
      connected: true,
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
    const before = await state();
    await declareStreamGap(fixture.database, "worker", NOW);
    expect(await state()).toEqual(before);
    await accept(event(20, "live"));
    // The staged document marks the origin for the sweep; its cursor stays.
    expect(await state()).toMatchObject({
      streamSeq: "1",
      stagedDueAt: new Date(0),
    });
    await process();
    expect((await state()).streamSeq).toBe("1");
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
    const transport = replay([event(10, "missed"), event(20, "live")], 20);
    const recover = vi.spyOn(transport, "recover");
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { manual: true, client, readPage },
    );
    expect(recover.mock.calls[0]?.[0]).toBe(1);
    expect(await state()).toMatchObject({
      streamGeneration: 1,
      streamMode: "live",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
  });

  it("keeps a newer interruption pending when it happens during repository reconciliation", async () => {
    await fixture.database.update(atprotoStreamState).set({
      seq: "1",
      generation: 1,
      connected: true,
      leaseOwner: "worker",
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
    const transport = { ...replay([], 30), hasReplay: false };
    const list = vi.fn(async () => {
      await declareStreamGap(fixture.database, "worker", NOW);
      return {
        records: [],
        notModified: false as const,
        cursor: undefined,
        etag: null,
      };
    });
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { manual: true, client: { ...client, list }, readPage },
    );
    expect((await state()).streamGeneration).toBe(1);
    expect((await ensureStream(fixture.database, SERVICE)).generation).toBe(2);
    // A gap clears the checkpoint; the worker re-establishes it at the tip.
    await fixture.database.update(atprotoStreamState).set({ seq: "30" });
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { manual: true, client: { ...client, list }, readPage },
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect((await state()).streamGeneration).toBe(2);
  });

  /** A connected worker whose saved checkpoint trails the events it has passed. */
  async function connectAtTrailingCheckpoint(checkpoint: number) {
    await fixture.database.update(atprotoStreamState).set({
      seq: String(checkpoint),
      connected: true,
      leaseOwner: "worker",
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
  }
  const recoverThrough = (transport: StreamTransport) =>
    recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { manual: true, client, readPage },
    );

  it("catches up to the live tip, past an event the worker dropped ahead of its trailing checkpoint", async () => {
    await connectAtTrailingCheckpoint(10);
    await fixture.database
      .update(user)
      .set({ lastActiveAt: null })
      .where(eq(user.id, "reader"));
    // The worker passes the event without applying it, and its heartbeat has
    // not saved that position yet.
    await acceptBatch(
      fixture.database,
      { events: [event(15, "missed")] },
      settings,
    );
    expect(await ledger(uri("missed"))).toBeUndefined();
    expect((await state()).streamMode).toBe("paused");
    // The reader returns and their refresh recovers before the next heartbeat.
    await fixture.database
      .update(user)
      .set({ lastActiveAt: NOW })
      .where(eq(user.id, "reader"));
    const transport = replayWithin([event(15, "missed")], 15);
    expect(await recoverThrough(transport)).toEqual({ status: "covered" });
    expect(transport.tip).toHaveBeenCalledTimes(1);
    expect(await state()).toMatchObject({
      streamMode: "live",
      streamSeq: "15",
    });
    expect(await ledger(uri("missed"))).toMatchObject({ eventSeq: "15" });
  });

  it("catches up a distrusted origin to the live tip when it recovers within one heartbeat", async () => {
    await connectAtTrailingCheckpoint(10);
    // The intake skipped event 15 before it followed the publisher and could
    // not vouch for the interval. The saved checkpoint still trails it.
    await distrustOriginCoverage(fixture.database, [originId], NOW);
    const transport = replayWithin([event(15, "missed")], 15);
    expect(await recoverThrough(transport)).toEqual({ status: "covered" });
    expect(await state()).toMatchObject({
      streamGeneration: 0,
      streamMode: "live",
      streamSeq: "15",
    });
    expect(await ledger(uri("missed"))).toMatchObject({ eventSeq: "15" });
  });

  it("preserves live updates that arrive while a no-key snapshot is being read", async () => {
    await fixture.database
      .update(atprotoStreamState)
      .set({ seq: "1", generation: 1 });
    const transport = {
      ...replay([], 30),
      hasReplay: false,
      tip: vi.fn().mockResolvedValueOnce(10).mockResolvedValue(30),
    };
    const list = async () => {
      await accept(event(20, "post", "New live title"));
      const old = event(2, "post", "Old snapshot title");
      if (old.kind !== "commit") throw new Error();
      return {
        records: [{ uri: uri("post"), cid: "old", value: old.commit.record }],
        notModified: false as const,
        cursor: undefined,
        etag: null,
      };
    };
    await recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { manual: true, client: { ...client, list }, readPage },
    );
    expect((await fixture.database.select().from(feedItems))[0]?.title).toBe(
      "New live title",
    );
  });
});

it("resumes a failed no-key handoff without fetching an already completed snapshot again", async () => {
  await pause(20);
  const transport = { ...replay([], 30), hasReplay: false };
  const recover = vi.spyOn(transport, "recover");
  recover.mockImplementationOnce(async function* () {
    yield { events: [], lastCursor: 30 };
    throw new StreamFailure("connection", 503);
  });
  const list = vi.fn(client.list);
  await expect(
    recoverOrigin(
      fixture.database,
      originId,
      settings,
      transport,
      new AbortController().signal,
      { client: { ...client, list }, readPage },
    ),
  ).rejects.toThrow("503");
  expect((await state()).streamMode).toBe("catchup");
  await fixture.database
    .update(feedOriginAtproto)
    .set({ recoveryRetryAt: null });
  await recoverOrigin(
    fixture.database,
    originId,
    settings,
    transport,
    new AbortController().signal,
    { client: { ...client, list }, readPage },
  );
  expect(list).toHaveBeenCalledTimes(1);
  expect((await state()).streamMode).toBe("live");
});

describe("fetch schedule", () => {
  const LATER = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
  async function connect() {
    await fixture.database.update(atprotoStreamState).set({
      seq: "1",
      connected: true,
      leaseOwner: "worker",
      leaseUntil: new Date(NOW.getTime() + 60_000),
    });
  }
  async function scheduleOrigin(id: number, nextFetchAt: Date | null) {
    await fixture.database
      .update(feedOrigins)
      .set({ nextFetchAt })
      .where(eq(feedOrigins.id, id));
  }
  async function nextFetchAt(id = originId) {
    const row = await fixture.database
      .select({ nextFetchAt: feedOrigins.nextFetchAt })
      .from(feedOrigins)
      .where(eq(feedOrigins.id, id))
      .get();
    return row!.nextFetchAt;
  }
  function refresh(id = originId) {
    return recoverOrigin(
      fixture.database,
      id,
      settings,
      replay([], 1),
      new AbortController().signal,
      { manual: true, client, readPage },
    );
  }

  it("reports an origin a connected worker applies live as covered", async () => {
    await connect();
    expect(await refresh()).toEqual({ status: "covered" });
  });

  it("reports an origin as polled when its reader gets no unprompted stream work", async () => {
    await connect();
    const dormant = await addReader("dormant", null);
    expect(await refresh(dormant.originId)).toEqual({ status: "polled" });
  });

  it("reports an origin as polled when recovery completes without a connected worker", async () => {
    await fixture.database.update(atprotoStreamState).set({ seq: "1" });
    expect(await refresh()).toEqual({ status: "polled" });
    expect((await state()).streamMode).toBe("live");
  });

  it("reports unfinished work when uncovered documents still wait", async () => {
    await connect();
    const dormant = await addReader("dormant", null);
    const staged = event(1);
    if (staged.kind !== "commit") throw new Error();
    for (let index = 0; index < 26; index++)
      await stageDocument(fixture.database, {
        originId: dormant.originId,
        uri: uri(`post-${index}`),
        cid: `cid-${index}`,
        record: captureRecordValue(staged.commit.record),
        seq: 1,
      });
    expect(await refresh(dormant.originId)).toEqual({ status: "unfinished" });
  });

  it("reports unfinished work while another attempt holds the origin", async () => {
    await fixture.database.update(atprotoStreamState).set({ seq: "1" });
    await fixture.database.update(feedOriginAtproto).set({
      workOwner: "other",
      workUntil: new Date(NOW.getTime() + 60_000),
    });
    expect(await refresh()).toEqual({ status: "unfinished" });
  });

  it("reports the backoff an earlier failure left", async () => {
    const retryAt = new Date(NOW.getTime() + 40_000);
    await fixture.database
      .update(feedOriginAtproto)
      .set({ recoveryRetryAt: retryAt });
    expect(await refresh()).toEqual({ status: "deferred", retryAt });
  });

  it("makes an origin due when the stream pauses it, and leaves an inactive Feed unscheduled", async () => {
    const dormant = await addReader("dormant", null);
    const inactive = await addReader("inactive");
    await fixture.database
      .update(feeds)
      .set({ isActive: false })
      .where(eq(feeds.id, inactive.feedId));
    await scheduleOrigin(originId, LATER);
    await scheduleOrigin(dormant.originId, LATER);
    await scheduleOrigin(inactive.originId, null);

    await accept(event(10));
    expect((await state(dormant.originId)).streamMode).toBe("paused");
    expect(await nextFetchAt(dormant.originId)).toEqual(NOW);
    expect((await state(inactive.originId)).streamMode).toBe("paused");
    expect(await nextFetchAt(inactive.originId)).toBeNull();
    // The eligible reader's origin stays covered.
    expect(await nextFetchAt()).toEqual(LATER);
  });

  it("makes live origins due when the stream declares a gap, and leaves polled and unscheduled origins alone", async () => {
    await connect();
    const polled = await addReader("polled");
    await fixture.database
      .update(feedOriginAtproto)
      .set({ streamMode: "catchup" })
      .where(eq(feedOriginAtproto.originId, polled.originId));
    const rss = await insertFeedWithOrigins(fixture.database, {
      userId: "reader",
      isActive: true,
      details: {
        name: "Syndication",
        platform: "website",
        imageUrl: "",
        origins: [{ kind: "rss", locator: "https://example.com/feed.xml" }],
      },
    });
    const inactive = await addReader("inactive");
    const far = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await scheduleOrigin(originId, far);
    await scheduleOrigin(polled.originId, far);
    await scheduleOrigin(rss.origins[0]!.id, far);
    await scheduleOrigin(inactive.originId, null);
    const before = Date.now();

    const [gap] = await declareStreamGap(
      fixture.database,
      "worker",
      new Date(),
    );
    expect(gap?.generation).toBe(1);
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0],
    ).toMatchObject({ seq: null, connected: false });
    expect((await nextFetchAt())!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await nextFetchAt())!.getTime()).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) * 1000,
    );
    // The stream never vouched for a polled origin, so its schedule stands.
    for (const id of [polled.originId, rss.origins[0]!.id])
      expect((await nextFetchAt(id))!.getTime()).toBe(
        Math.floor(far.getTime() / 1000) * 1000,
      );
    expect(await nextFetchAt(inactive.originId)).toBeNull();
  });

  it("leaves the generation, the checkpoint and schedules alone when a connection ends", async () => {
    await connect();
    await scheduleOrigin(originId, LATER);
    const before = await state();

    await disconnectStream(fixture.database, "worker");
    expect(
      (await fixture.database.select().from(atprotoStreamState))[0],
    ).toMatchObject({ connected: false, generation: 0, seq: "1" });
    expect(await state()).toEqual(before);
    expect(await nextFetchAt()).toEqual(LATER);
  });

  it("sends an origin the stream could not vouch for back through catch-up at its next refresh", async () => {
    await connect();
    await scheduleOrigin(originId, LATER);
    const inactive = await addReader("inactive");
    await scheduleOrigin(inactive.originId, null);
    await accept(event(10));
    expect((await state()).streamSeq).toBe("10");

    await distrustOriginCoverage(
      fixture.database,
      [originId, inactive.originId],
      NOW,
    );
    expect(await nextFetchAt()).toEqual(NOW);
    expect(await nextFetchAt(inactive.originId)).toBeNull();
    // Outside the current generation the origin keeps its cursor as live
    // events arrive, so catch-up replays everything after it.
    await accept(event(12, "later"));
    expect((await state()).streamSeq).toBe("10");
    const transport = replay([event(11, "missed"), event(12, "later")], 12);
    const recover = vi.spyOn(transport, "recover");
    expect(
      await recoverOrigin(
        fixture.database,
        originId,
        settings,
        transport,
        new AbortController().signal,
        { manual: true, client, readPage },
      ),
    ).toEqual({ status: "covered" });
    expect(recover.mock.calls[0]?.[0]).toBe(10);
    expect(await state()).toMatchObject({
      streamGeneration: 0,
      streamMode: "live",
    });
    expect(await ledger(uri("missed"))).toMatchObject({ eventSeq: "11" });
  });
});

describe("stream lease and checkpoint", () => {
  const stream = async () =>
    (await fixture.database.select().from(atprotoStreamState))[0]!;

  it("saves the checkpoint with the lease and never moves it back", async () => {
    expect(await holdStream(fixture.database, "worker", NOW, 20)).toBe(true);
    expect(await stream()).toMatchObject({
      leaseOwner: "worker",
      leaseUntil: new Date(NOW.getTime() + 60_000),
      seq: "20",
    });
    expect(await holdStream(fixture.database, "worker", NOW, 10)).toBe(true);
    expect((await stream()).seq).toBe("20");
    // Renewing without progress leaves the checkpoint alone.
    expect(await holdStream(fixture.database, "worker", NOW)).toBe(true);
    expect((await stream()).seq).toBe("20");
  });

  it("refuses another worker's lease and its checkpoint until the lease runs out", async () => {
    await holdStream(fixture.database, "worker", NOW, 20);
    expect(await holdStream(fixture.database, "other", NOW, 30)).toBe(false);
    await saveCheckpoint(fixture.database, "other", 30);
    expect(await stream()).toMatchObject({ leaseOwner: "worker", seq: "20" });
    const later = new Date(NOW.getTime() + 61_000);
    expect(await holdStream(fixture.database, "other", later, 30)).toBe(true);
    expect(await stream()).toMatchObject({ leaseOwner: "other", seq: "30" });
  });

  it("saves a closing connection's progress without extending its lease", async () => {
    await holdStream(fixture.database, "worker", NOW, 20);
    await saveCheckpoint(fixture.database, "worker", 25);
    expect(await stream()).toMatchObject({
      leaseUntil: new Date(NOW.getTime() + 60_000),
      seq: "25",
    });
  });

  it("applies events without saving stream progress", async () => {
    await acceptBatch(fixture.database, { events: [event(10)] }, settings);
    expect((await state()).streamSeq).toBe("10");
    expect((await stream()).seq).toBeNull();
  });

  it("marks a connection live only for the lease holder at its generation", async () => {
    await holdStream(fixture.database, "worker", NOW);
    expect(await connectStream(fixture.database, "other", 0, NOW)).toBe(false);
    expect(await connectStream(fixture.database, "worker", 1, NOW)).toBe(false);
    expect((await stream()).connected).toBe(false);
    expect(await connectStream(fixture.database, "worker", 0, NOW)).toBe(true);
    expect((await stream()).connected).toBe(true);
  });
});

describe("retry sweep", () => {
  const AT_ONCE = new Date(0);
  const later = (ms: number) => new Date(NOW.getTime() + ms);
  const due = (now = NOW) => originsWithDueWork(fixture.database, now);
  const sweep = (holdsLease: boolean) =>
    drainDueOrigins(fixture.database, settings, {
      holdsLease: () => holdsLease,
      signal: new AbortController().signal,
      client,
      readPage,
    });
  /** A document whose required body cannot be fetched, so every import fails. */
  function unreadable(seq: number, key = "broken") {
    const broken = event(seq, key);
    if (broken.kind !== "commit") throw new Error();
    broken.commit.record = {
      $type: "site.standard.document",
      site: PUB,
      title: "Broken",
      path: `/${key}`,
      publishedAt: NOW.toISOString(),
      content: {
        $type: "pub.leaflet.content",
        blobPages: { ref: { $link: "bafybody" } },
      },
    };
    return broken;
  }
  /**
   * One pass at a given time, against a repository that serves no blob. The
   * reader's plan qualifies however long ago they were last active.
   */
  const failingPass = (now: Date) =>
    processOriginDocuments(
      fixture.database,
      originId,
      { ...settings, now: () => now, getPlanId: async () => "pro" },
      {
        client: {
          ...client,
          loadBlob: async () => {
            throw new Error("Required body unavailable");
          },
        },
        readPage,
      },
    );
  const readablePublication = { name: "Fixed", url: "https://example.com" };
  /** The publisher rewriting the Publication record, as the stream reports it. */
  function publicationEdit(seq: number, record: unknown): StreamEvent {
    return {
      seq,
      did: DID,
      time: NOW.toISOString(),
      kind: "commit",
      commit: {
        operation: "update",
        collection: "site.standard.publication",
        rkey: "site",
        rev: String(seq).padStart(13, "0"),
        cid: `pubcid${seq}`,
        record,
      },
    };
  }
  /** Staged documents waiting out a backoff, written the way a failed pass leaves them. */
  async function stageInBackoff(id: number, count: number, retryAt: Date) {
    await fixture.database.insert(feedOriginAtprotoDocuments).values(
      Array.from({ length: count }, (_, index) => ({
        originId: id,
        uri: uri(`waiting-${index}`),
        cid: `waiting-${index}`,
        status: "retry" as const,
        attempts: 3,
        retryAt,
      })),
    );
    await fixture.database
      .update(feedOriginAtproto)
      .set({ stagedDueAt: retryAt })
      .where(eq(feedOriginAtproto.originId, id));
  }

  it("finds nothing while no document is staged and no Publication changed", async () => {
    expect(await due()).toEqual([]);
    await accept(event(10));
    await process();
    expect(await due()).toEqual([]);
    expect((await state()).stagedDueAt).toBeNull();
  });

  it("finds an origin from the moment a document is staged until none is due", async () => {
    await accept(unreadable(10));
    expect((await state()).stagedDueAt).toEqual(AT_ONCE);
    expect(await due()).toEqual([originId]);
    // The failed import waits a minute, and so does the origin.
    await failingPass(NOW);
    expect(await ledger(uri("broken"))).toMatchObject({
      status: "retry",
      attempts: 1,
      retryAt: later(60_000),
    });
    expect((await state()).stagedDueAt).toEqual(later(60_000));
    expect(await due()).toEqual([]);
    expect(await due(later(59_999))).toEqual([]);
    expect(await due(later(60_000))).toEqual([originId]);
    // A document staged meanwhile is due at once, ahead of the waiting one.
    await accept(event(11, "good"));
    expect((await state()).stagedDueAt).toEqual(AT_ONCE);
    expect(await due()).toEqual([originId]);
    await process();
    expect(await ledger(uri("good"))).toMatchObject({ status: "ready" });
    expect((await state()).stagedDueAt).toEqual(later(60_000));
    expect(await due()).toEqual([]);
  });

  it("moves the origin's cursor with the mark, and alone once documents are due", async () => {
    await accept(event(10));
    expect(await state()).toMatchObject({
      stagedDueAt: AT_ONCE,
      streamSeq: "10",
    });
    await accept(event(11, "second"));
    expect(await state()).toMatchObject({
      stagedDueAt: AT_ONCE,
      streamSeq: "11",
    });
  });

  it("finds an origin whose Publication record waits to be applied", async () => {
    await fixture.database
      .update(feedOriginAtproto)
      .set({ publicationDirty: true });
    expect(await due()).toEqual([originId]);
    // An origin with both kinds of work is visited once.
    await accept(event(10));
    expect(await due()).toEqual([originId]);
  });

  it("reads no staged document, however many wait out a backoff", async () => {
    await stageInBackoff(originId, 300, later(3_600_000));
    const statements = vi.spyOn(fixture.database, "all");
    expect(await due()).toEqual([]);
    expect(statements).toHaveBeenCalledTimes(1);
    expect(await due(later(3_600_000))).toEqual([originId]);
  });

  it("leaves origins the stream is not applying live to their own refresh", async () => {
    await accept(event(10));
    await stageInBackoff(originId, 300, NOW);
    await fixture.database
      .update(feedOriginAtproto)
      .set({ publicationDirty: true, streamMode: "paused" });
    expect(await due()).toEqual([]);
    await fixture.database
      .update(feedOriginAtproto)
      .set({ streamMode: "catchup" });
    expect(await due()).toEqual([]);
    await fixture.database
      .update(feedOriginAtproto)
      .set({ streamMode: "live", repositoryActive: false });
    expect(await due()).toEqual([]);
    await fixture.database
      .update(feedOriginAtproto)
      .set({ repositoryActive: true, initialized: false });
    expect(await due()).toEqual([]);
    // Its work was only waiting: the origin is found again once it qualifies.
    await fixture.database.update(feedOriginAtproto).set({ initialized: true });
    expect(await due()).toEqual([originId]);
  });

  it.each([
    [
      "an inactive Feed",
      () =>
        fixture.database
          .update(feeds)
          .set({ isActive: false })
          .where(eq(feeds.id, feedId)),
    ],
    [
      "a reader who no longer qualifies",
      () =>
        fixture.database
          .update(user)
          .set({ lastActiveAt: null })
          .where(eq(user.id, "reader")),
    ],
  ])("selects the origin of %s at most once", async (_, disqualify) => {
    await accept(event(10));
    await disqualify();
    expect(await due()).toEqual([originId]);
    await sweep(true);
    // The sweep pauses it, the way an arriving event would, so its staged
    // work stops asking for a sweep and waits for the origin's refresh.
    expect((await state()).streamMode).toBe("paused");
    expect(await ledger(uri("post"))).toMatchObject({ status: "retry" });
    expect(await due()).toEqual([]);
  });

  it("holds no due work for an origin whose Publication is gone", async () => {
    await accept(event(10));
    await fixture.database
      .update(feedOriginAtproto)
      .set({ publicationRecord: null, publicationSeq: "5" });
    expect(await due()).toEqual([originId]);
    await sweep(true);
    // The staged document waits for the Publication without asking again.
    expect(await ledger(uri("post"))).toMatchObject({ status: "retry" });
    expect((await state()).stagedDueAt).toBeNull();
    expect(await due()).toEqual([]);
    // Its return is work of its own, and that pass imports what waited.
    await fixture.database
      .update(feedOriginAtproto)
      .set({ publicationRecord: publication, publicationDirty: true });
    await sweep(true);
    expect(await ledger(uri("post"))).toMatchObject({ status: "ready" });
    expect(await due()).toEqual([]);
  });

  it("holds no due work for an origin whose Publication does not parse", async () => {
    await accept(event(10), publicationEdit(11, { name: "No address" }));
    expect(await state()).toMatchObject({
      publicationDirty: true,
      publicationSeq: "11",
    });
    expect(await due()).toEqual([originId]);
    await sweep(true);
    // Neither the record nor the staged document asks for a second sweep.
    expect(await state()).toMatchObject({
      publicationDirty: false,
      stagedDueAt: null,
    });
    expect(await ledger(uri("post"))).toMatchObject({ status: "retry" });
    expect(await due()).toEqual([]);
    // The publisher's next edit is work of its own, and that pass imports what waited.
    await accept(publicationEdit(12, readablePublication));
    expect(await due()).toEqual([originId]);
    await sweep(true);
    expect(await ledger(uri("post"))).toMatchObject({ status: "ready" });
    expect(await due()).toEqual([]);
  });

  it("restates when a waiting document is due once the Publication parses again", async () => {
    await stageInBackoff(originId, 1, later(3_600_000));
    await accept(publicationEdit(11, { name: "No address" }));
    await sweep(true);
    expect((await state()).stagedDueAt).toBeNull();
    await accept(publicationEdit(12, readablePublication));
    await sweep(true);
    // Nothing was due in that pass, and the document's wait still stands.
    expect(await state()).toMatchObject({
      publicationDirty: false,
      stagedDueAt: later(3_600_000),
    });
    expect(await due(later(3_600_000))).toEqual([originId]);
  });

  it("keeps the mark of a Publication event that arrives while a pass finds no readable record", async () => {
    await fixture.database
      .update(feedOriginAtproto)
      .set({ publicationRecord: null });
    await accept(event(10));
    await expect(
      processOriginDocuments(fixture.database, originId, settings, {
        client: {
          ...client,
          // The repository still serves the unreadable record the event replaces.
          getRecord: async () => {
            await accept(publicationEdit(11, readablePublication));
            return { uri: PUB, cid: "unreadable", value: {} };
          },
        },
        readPage,
      }),
    ).rejects.toThrow("Invalid Publication record");
    expect(await state()).toMatchObject({
      publicationDirty: true,
      stagedDueAt: AT_ONCE,
    });
    expect(await due()).toEqual([originId]);
    await sweep(true);
    expect(await ledger(uri("post"))).toMatchObject({ status: "ready" });
    expect(await due()).toEqual([]);
  });

  it("visits each origin once in a pass, whichever work it holds", async () => {
    const second = await addReader("second");
    const third = await addReader("third");
    // The first origin holds a document, the second a Publication record to
    // apply, and the third both.
    await accept(unreadable(10));
    await fixture.database
      .delete(feedOriginAtprotoDocuments)
      .where(eq(feedOriginAtprotoDocuments.originId, second.originId));
    await fixture.database
      .update(feedOriginAtproto)
      .set({ stagedDueAt: null, publicationDirty: true })
      .where(eq(feedOriginAtproto.originId, second.originId));
    await fixture.database
      .update(feedOriginAtproto)
      .set({ publicationDirty: true })
      .where(eq(feedOriginAtproto.originId, third.originId));
    expect((await due()).sort((left, right) => left - right)).toEqual([
      originId,
      second.originId,
      third.originId,
    ]);
    // The clock passes a failed document's wait between any two statements,
    // so a second visit to an origin would find its document due and fail it
    // again.
    let clock = NOW.getTime();
    const loadBlob = vi.fn(async () => {
      throw new Error("Required body unavailable");
    });
    await drainDueOrigins(
      fixture.database,
      {
        ...settings,
        now: () => new Date((clock += 120_000)),
        getPlanId: async () => "pro",
      },
      {
        holdsLease: () => true,
        signal: new AbortController().signal,
        client: { ...client, loadBlob },
        readPage,
      },
    );
    expect(loadBlob).toHaveBeenCalledTimes(2);
    expect(
      await fixture.database
        .select({
          originId: feedOriginAtprotoDocuments.originId,
          attempts: feedOriginAtprotoDocuments.attempts,
        })
        .from(feedOriginAtprotoDocuments)
        .orderBy(feedOriginAtprotoDocuments.originId),
    ).toEqual([
      { originId, attempts: 1 },
      { originId: third.originId, attempts: 1 },
    ]);
    expect(
      await fixture.database
        .select({
          originId: feedOriginAtproto.originId,
          publicationDirty: feedOriginAtproto.publicationDirty,
        })
        .from(feedOriginAtproto)
        .orderBy(feedOriginAtproto.originId),
    ).toEqual([
      { originId, publicationDirty: false },
      { originId: second.originId, publicationDirty: false },
      { originId: third.originId, publicationDirty: false },
    ]);
  });

  it("stops retrying a document after 14 days of failures, until its publisher edits it", async () => {
    await accept(unreadable(10));
    /** One failing pass, and what it leaves on the ledger. */
    const failAt = async (time: Date) => {
      await failingPass(time);
      return (await ledger(uri("broken")))!;
    };
    let now = NOW;
    for (let failure = 1; failure < 25; failure++) {
      // Each pass runs when the previous failure's wait has passed.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const waiting = await failAt(now);
      expect(waiting).toMatchObject({ status: "retry", attempts: failure });
      now = waiting.retryAt!;
    }
    // Doubling from a minute to a day, the waits served by now reach 14 days.
    expect(now.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(
      14 * 24 * 60 * 60 * 1000,
    );
    expect(await failAt(now)).toMatchObject({
      status: "invalid",
      reason: "failed",
    });
    // The failed version is not retained, and the origin holds no due work.
    expect(await sources(uri("broken"))).toEqual([]);
    expect((await state()).stagedDueAt).toBeNull();
    expect(await due(later(365 * 24 * 60 * 60 * 1000))).toEqual([]);
    // A stream replay of the same version does not bring it back.
    await accept(unreadable(10));
    expect(await ledger(uri("broken"))).toMatchObject({ status: "invalid" });
    // The publisher's edit is a new version with every retry ahead of it.
    await accept(event(11, "broken", "Fixed", "update"));
    expect(await ledger(uri("broken"))).toMatchObject({
      status: "retry",
      attempts: 0,
      retryAt: null,
      reason: null,
    });
    expect(await due()).toEqual([originId]);
    await process();
    expect(await ledger(uri("broken"))).toMatchObject({ status: "ready" });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  }, 30_000);

  it("drains staged work on the instance holding the lease, and none without it", async () => {
    await accept(event(10));
    const query = vi.spyOn(fixture.database, "all");
    await sweep(false);
    expect(query).not.toHaveBeenCalled();
    expect(await ledger(uri("post"))).toMatchObject({ status: "retry" });
    await sweep(true);
    expect(await ledger(uri("post"))).toMatchObject({ status: "ready" });
    // One statement finds every origin with due work.
    expect(query).toHaveBeenCalledTimes(1);
  });
});

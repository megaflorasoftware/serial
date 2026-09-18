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
  ensureStream,
  stageDocument,
} from "~/server/jetstream/store";
import { processOriginDocuments } from "~/server/jetstream/process";
import {
  atprotoStreamState,
  feedItems,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feeds,
  user,
} from "~/server/db/schema";
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
  latestRev: vi.fn(async () => "rev"),
  getRecord: vi.fn(async () => publication),
  loadBlob: vi.fn(async () => new Uint8Array()),
  resolveRecord: vi.fn(async () => null),
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
async function accept(...events: StreamEvent[]) {
  await acceptBatch(
    fixture.database,
    { events, lastCursor: events.at(-1)!.seq },
    settings,
  );
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
beforeEach(async () => {
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
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("retains reader copies on delete and prevents a stale replay from recreating pending work", async () => {
    await accept(event(10));
    await process();
    await accept(event(12, "post", "", "delete"));
    await acceptBatch(
      fixture.database,
      { events: [event(11, "post", "stale")], lastCursor: 11 },
      settings,
      { originId },
    );
    await process();
    expect((await fixture.database.select().from(feedItems))[0]?.title).toBe(
      "Title",
    );
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0]
        ?.status,
    ).toBe("deleted");
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
      { events: [event(10, "old", "Missed")], lastCursor: 10 },
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
          record: bootstrap.commit.record,
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
  it("uses live resume without a replay key before resorting to direct repository recovery", async () => {
    await pause(20);
    const transport = { ...replay([event(10)], 20), hasReplay: false };
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
    expect(list).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({
      streamSeq: "20",
      streamMode: "live",
    });
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  });
  it("uses direct recovery for an expired no-key cursor and then covers concurrent changes", async () => {
    await pause(20);
    let attempt = 0;
    const transport: StreamTransport = {
      ...replay([], 30),
      hasReplay: false,
      async *recover() {
        if (attempt++ === 0) throw new StreamFailure("cursor-expired", 400);
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
    expect(pending?.pendingRecord).toBeTruthy();
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
  it("queues only the latest 200 initial documents and applies concurrent edits before rendering", async () => {
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
      replay([event(2, "800", "Latest")], 3),
      new AbortController().signal,
      { client: remote, readPage },
    );
    expect(remote.list).toHaveBeenCalledTimes(2);
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(200);
    expect(
      (
        await fixture.database
          .select()
          .from(feedItems)
          .where(eq(feedItems.atprotoUri, uri("800")))
          .get()
      )?.title,
    ).toBe("Latest");
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
    await acceptBatch(
      fixture.database,
      { events: [deletion], lastCursor: 20 },
      settings,
      { originId },
    );
    expect(
      (await fixture.database.select().from(feedOriginAtprotoDocuments))[0],
    ).toMatchObject({ eventSeq: "30", status: "retry" });
  });
  it("orders account and sync state independently during replay", async () => {
    await accept(event(30));
    await acceptBatch(
      fixture.database,
      { events: [marker(25, "sync"), marker(20, "account")], lastCursor: 25 },
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
    await acceptBatch(
      fixture.database,
      { events: [event(10)], lastCursor: 10 },
      settings,
      { originId },
    );
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
    let attempt = 0;
    const transport: StreamTransport = {
      ...replay([], 30),
      hasReplay: false,
      async *recover() {
        if (attempt++ === 0) throw new StreamFailure("cursor-expired", 400);
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
    let attempt = 0;
    const transport: StreamTransport = {
      ...replay([], 30),
      hasReplay: false,
      async *recover() {
        if (attempt++ === 0) throw new StreamFailure("cursor-expired", 400);
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

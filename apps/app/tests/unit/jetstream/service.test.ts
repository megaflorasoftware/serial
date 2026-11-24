import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type * as Store from "~/server/jetstream/store";
import type { StreamTransport } from "~/server/jetstream/transport";
import type { StreamEvent } from "~/server/jetstream/protocol";
import {
  refreshStreamOrigin,
  startStreamWorker,
} from "~/server/jetstream/service";
import { insertFeedWithOrigins, withOrigins } from "~/server/feeds/origins";
import {
  atprotoStreamState,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { StreamFailure } from "~/server/jetstream/protocol";
import { declareStreamGap, disconnectStream } from "~/server/jetstream/store";
import { resolveStreamService } from "~/server/jetstream/endpoint";
import { refreshUserFeeds } from "~/server/rss/refreshUserFeeds";
import { STREAM_HOST_RECHECK_MS } from "~/server/rss/fetchFeeds";
import { publisher } from "~/server/api/publisher";
import { captureException } from "~/server/logger";

const state = vi.hoisted(() => ({
  transport: undefined as StreamTransport | undefined,
}));
vi.mock("~/env", () => ({
  env: {
    ATPROTO_JETSTREAM_ENDPOINT: "https://jetstream.example.com",
    BACKGROUND_REFRESH_ENABLED: true,
  },
}));
vi.mock("~/server/jetstream/endpoint", () => ({
  resolveStreamService: vi.fn(async (url: string) => url),
}));
vi.mock("~/server/jetstream/store", async (original) => {
  const actual = await original<typeof Store>();
  return {
    ...actual,
    declareStreamGap: vi.fn(actual.declareStreamGap),
    disconnectStream: vi.fn(actual.disconnectStream),
  };
});
vi.mock("~/server/jetstream/transport", () => ({
  createStreamTransport: () => state.transport,
  retryStream: vi.fn(async () => {}),
}));
vi.mock("~/server/api/publisher", () => ({ publisher: { publish: vi.fn() } }));
vi.mock("~/server/subscriptions/helpers", () => ({
  getUserPlanId: async () => "pro",
}));
vi.mock("~/server/logger", () => ({
  captureException: vi.fn(),
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>> | undefined;
afterEach(() => fixture?.cleanup());

it("receives events for a Publication followed after the connection starts", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const shutdown = new AbortController();
  const service = "https://jetstream.example.com";
  await database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const follow = async (did: string) => {
    const feed = await insertFeedWithOrigins(database, {
      userId: "reader",
      isActive: true,
      details: {
        name: "Feed",
        platform: "website",
        imageUrl: "",
        origins: [
          {
            kind: "atproto",
            locator: `at://${did}/site.standard.publication/site`,
          },
        ],
      },
    });
    const originId = feed.origins[0]!.id;
    // Catch-up mode retains staged events while its own bootstrap finishes.
    await database
      .update(feedOriginAtproto)
      .set({ streamService: service, streamSeq: "1", streamMode: "catchup" })
      .where(eq(feedOriginAtproto.originId, originId));
    return originId;
  };
  await follow("did:plc:original");
  await database
    .insert(atprotoStreamState)
    .values({ id: "primary", service, seq: "1" });
  let newcomer = 0;
  state.transport = {
    service,
    hasReplay: true,
    report: vi.fn(),
    tip: async () => 1,
    recover() {
      throw new Error("Bootstrap deferred in this fixture");
    },
    async *stream(_after, _signal, dids) {
      const did = "did:plc:newcomer";
      newcomer = await follow(did);
      if (!dids || dids.includes(did))
        yield {
          lastCursor: 2,
          events: [
            {
              seq: 2,
              did,
              time: new Date().toISOString(),
              kind: "commit",
              commit: {
                operation: "create",
                collection: "site.standard.document",
                rkey: "post",
                rev: "2222222222222",
                cid: "cid",
                record: {
                  site: `at://${did}/site.standard.publication/site`,
                  title: "New item",
                  path: "/post",
                  publishedAt: new Date().toISOString(),
                },
              },
            },
          ],
        };
      shutdown.abort();
    },
  };
  // Skip actual PDS bootstrap in the independent background sweep.
  await database
    .update(feedOriginAtproto)
    .set({ recoveryRetryAt: new Date(Date.now() + 60000) });
  try {
    await startStreamWorker(database, shutdown.signal);
    expect(
      await database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.originId, newcomer)),
    ).toHaveLength(1);
  } finally {
    shutdown.abort();
  }
});

it.each([true, false])(
  "restarts and reconnects live without repository/archive recovery, archive=%s",
  async (hasReplay) => {
    fixture = await createBookmarkTestDatabase();
    const database = fixture.database;
    const service = "https://jetstream.example.com";
    const shutdown = new AbortController();
    const now = new Date();
    await database.insert(user).values({
      id: "reader",
      name: "Reader",
      email: "reader@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const locator = "at://did:plc:alice/site.standard.publication/site";
    const feed = await insertFeedWithOrigins(database, {
      userId: "reader",
      isActive: true,
      details: {
        name: "Publication",
        platform: "website",
        imageUrl: "",
        origins: [{ kind: "atproto", locator }],
      },
    });
    await database.update(feedOriginAtproto).set({
      initialized: true,
      streamService: service,
      streamSeq: "1",
      streamMode: "live",
      publicationRecord: {
        uri: locator,
        cid: "pub",
        value: { name: "Publication", url: "https://example.com" },
      },
    });
    await database
      .insert(atprotoStreamState)
      .values({ id: "primary", service, seq: "1" });
    const covered = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await database.update(feedOrigins).set({ nextFetchAt: covered });
    const before = await database.select().from(feedOriginAtproto);
    const schedules = await database.select().from(feedOrigins);
    let attempts = 0;
    const recover = vi.fn(() => {
      throw new Error("Recovery must wait for a normal fetch");
    });
    const tip = vi.fn(async () => 1);
    state.transport = {
      service,
      hasReplay,
      recover,
      tip,
      report: vi.fn(),
      async *stream(_after, _signal, _dids, onOpen) {
        await onOpen?.();
        expect(
          (await database.select().from(atprotoStreamState))[0]?.connected,
        ).toBe(true);
        attempts++;
        yield { events: [], lastCursor: attempts + 1 };
        if (attempts === 1) throw new Error("upstream disconnected");
        shutdown.abort();
      },
    };
    try {
      await startStreamWorker(database, shutdown.signal);
      expect(attempts).toBe(2);
      expect(recover).not.toHaveBeenCalled();
      expect(tip).not.toHaveBeenCalled();
      expect(await database.select().from(feedOriginAtproto)).toEqual(before);
      // The second connection resumed from the checkpoint, so nothing was
      // missed: the generation and every schedule stand.
      expect(await database.select().from(feedOrigins)).toEqual(schedules);
      expect(
        (await database.select().from(atprotoStreamState))[0],
      ).toMatchObject({ connected: false, generation: 0, seq: "3" });
      expect(feed.origins).toHaveLength(1);
    } finally {
      shutdown.abort();
    }
  },
);

it("reports a pending recovery retry as a fetch error instead of an empty refresh", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const now = new Date();
  await database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const feed = await insertFeedWithOrigins(database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Feed",
      platform: "website",
      imageUrl: "",
      origins: [
        {
          kind: "atproto",
          locator: "at://did:plc:alice/site.standard.publication/site",
        },
      ],
    },
  });
  await database
    .insert(atprotoStreamState)
    .values({ id: "primary", service, seq: "1" });
  const tip = vi.fn(async () => {
    throw new Error("Jetstream unavailable");
  });
  state.transport = {
    service,
    hasReplay: false,
    recover: vi.fn(),
    tip,
    report: vi.fn(),
    async *stream() {},
  };
  const fetchable = { feed, origin: feed.origins[0]! };
  const first = await refreshStreamOrigin(database, fetchable);
  expect(first.result.status).toBe("error");
  const origin = await database.select().from(feedOriginAtproto).get();
  expect(origin?.recoveryRetryAt?.getTime()).toBeGreaterThan(Date.now());
  // The failed recovery's backoff is what the fetch schedule waits for.
  expect(first.outcome).toEqual({
    status: "deferred",
    retryAt: origin?.recoveryRetryAt,
  });
  tip.mockClear();
  const second = await refreshStreamOrigin(database, fetchable);
  expect(second.result.status).toBe("error");
  expect(second.outcome).toEqual(first.outcome);
  expect(tip).not.toHaveBeenCalled();
});

/** One reader following `did` with a live, covered origin. */
async function liveReader(
  database: NonNullable<typeof fixture>["database"],
  service: string,
  did: string,
) {
  const now = new Date();
  await database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const locator = `at://${did}/site.standard.publication/site`;
  const feed = await insertFeedWithOrigins(database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Publication",
      platform: "website",
      imageUrl: "",
      origins: [{ kind: "atproto", locator }],
    },
  });
  await database.update(feedOriginAtproto).set({
    initialized: true,
    streamService: service,
    streamSeq: "1",
    streamMode: "live",
    publicationRecord: {
      uri: locator,
      cid: "pub",
      value: { name: "Publication", url: "https://example.com" },
    },
    // Keep document processing, and its network calls, out of these tests.
    repositoryActive: false,
  });
  await database
    .insert(atprotoStreamState)
    .values({ id: "primary", service, seq: "1" });
  return { locator, originId: feed.origins[0]!.id };
}
function documentEvent(seq: number, did: string, rkey: string): StreamEvent {
  return {
    seq,
    did,
    time: new Date().toISOString(),
    kind: "commit",
    commit: {
      operation: "create",
      collection: "site.standard.document",
      rkey,
      rev: String(seq).padStart(13, "0"),
      cid: `cid-${rkey}`,
      record: {
        site: `at://${did}/site.standard.publication/site`,
        title: rkey,
        path: `/${rkey}`,
        publishedAt: new Date().toISOString(),
      },
    },
  };
}

it("saves the checkpoint when a connection ends, not per event, and re-applies a replayed window once", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const shutdown = new AbortController();
  const did = "did:plc:alice";
  await liveReader(database, service, did);
  const checkpoint = async () =>
    (await database.select().from(atprotoStreamState))[0]!.seq;
  const resumedFrom: Array<number | undefined> = [];
  const duringStream: Array<string | null> = [];
  state.transport = {
    service,
    hasReplay: true,
    recover: vi.fn(),
    tip: vi.fn(async () => 1),
    report: vi.fn(),
    async *stream(after, _signal, _dids, onOpen) {
      await onOpen?.();
      resumedFrom.push(after);
      yield { events: [documentEvent(2, did, "a")], lastCursor: 2 };
      // The first event is applied by now; its position is not saved yet.
      duringStream.push(await checkpoint());
      yield { events: [documentEvent(3, did, "b")], lastCursor: 3 };
      if (resumedFrom.length === 1) throw new Error("upstream disconnected");
      yield { events: [documentEvent(4, did, "c")], lastCursor: 4 };
      shutdown.abort();
    },
  };
  try {
    await startStreamWorker(database, shutdown.signal);
    expect(duringStream[0]).toBe("1");
    // The closing connection left its position for the next one.
    expect(resumedFrom).toEqual([1, 3]);
    expect(await checkpoint()).toBe("4");
    // The second connection replayed two events the first already applied.
    expect(
      (await database.select().from(feedOriginAtprotoDocuments))
        .map(
          (document) =>
            `${document.uri.split("/").at(-1)}@${document.eventSeq}`,
        )
        .sort(),
    ).toEqual(["a@2", "b@3", "c@4"]);
  } finally {
    shutdown.abort();
  }
});

it("declares a gap when the service rejects the resume cursor, once", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const shutdown = new AbortController();
  const { originId } = await liveReader(database, service, "did:plc:alice");
  const covered = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await database.update(feedOrigins).set({ nextFetchAt: covered });
  const resumedFrom: Array<number | undefined> = [];
  state.transport = {
    service,
    hasReplay: true,
    recover: vi.fn(),
    tip: vi.fn(async () => 1),
    report: vi.fn(),
    async *stream(after, _signal, _dids, onOpen) {
      resumedFrom.push(after);
      if (after === 1) throw new StreamFailure("cursor-expired", 400);
      // A cleared checkpoint is re-established from the live tip.
      if (after === undefined) {
        yield { events: [], lastCursor: 50 };
        return;
      }
      await onOpen?.();
      shutdown.abort();
    },
  };
  try {
    await startStreamWorker(database, shutdown.signal);
    expect(resumedFrom).toEqual([1, undefined, 50]);
    expect((await database.select().from(atprotoStreamState))[0]).toMatchObject(
      { generation: 1, seq: "50" },
    );
    const origin = (await database
      .select()
      .from(feedOrigins)
      .where(eq(feedOrigins.id, originId))
      .get())!;
    expect(origin.nextFetchAt!.getTime()).toBeLessThanOrEqual(Date.now());
  } finally {
    shutdown.abort();
  }
});

it("keeps running when the database fails between connections", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const shutdown = new AbortController();
  await liveReader(database, service, "did:plc:alice");
  const unavailable = new Error("database unavailable");
  vi.mocked(disconnectStream).mockRejectedValueOnce(unavailable);
  vi.mocked(declareStreamGap).mockRejectedValueOnce(unavailable);
  const resumedFrom: Array<number | undefined> = [];
  const report = vi.fn();
  state.transport = {
    service,
    hasReplay: true,
    recover: vi.fn(),
    tip: vi.fn(async () => 1),
    report,
    async *stream(after, _signal, _dids, onOpen) {
      resumedFrom.push(after);
      // The gap is declared on the second refusal, after the first write failed.
      if (after === 1) throw new StreamFailure("cursor-expired", 400);
      if (after === undefined) {
        yield { events: [], lastCursor: 50 };
        return;
      }
      await onOpen?.();
      shutdown.abort();
    },
  };
  try {
    await startStreamWorker(database, shutdown.signal);
    expect(resumedFrom).toEqual([1, 1, undefined, 50]);
    expect(report).toHaveBeenCalledWith(unavailable, "gap");
    expect(report).toHaveBeenCalledWith(unavailable, "lease");
    expect((await database.select().from(atprotoStreamState))[0]).toMatchObject(
      { generation: 1, seq: "50", connected: false },
    );
  } finally {
    shutdown.abort();
  }
});

it("sends a followed Publication through recovery when the stream passes over one of its messages", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const shutdown = new AbortController();
  const { originId } = await liveReader(database, service, "did:plc:alice");
  const due = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await database.update(feedOrigins).set({ nextFetchAt: due });
  state.transport = {
    service,
    hasReplay: false,
    recover: vi.fn(),
    tip: vi.fn(async () => 1),
    report: vi.fn(),
    async *stream(_after, _signal, _dids, onOpen, onUnreadable) {
      await onOpen?.();
      onUnreadable?.("did:plc:stranger");
      onUnreadable?.("did:plc:alice");
      yield { events: [], lastCursor: 2 };
      shutdown.abort();
    },
  };
  try {
    await startStreamWorker(database, shutdown.signal);
    // Outside every stream generation, and due for its refresh now.
    expect(
      await database
        .select()
        .from(feedOriginAtproto)
        .where(eq(feedOriginAtproto.originId, originId)),
    ).toMatchObject([{ streamGeneration: -1 }]);
    const [schedule] = await database
      .select()
      .from(feedOrigins)
      .where(eq(feedOrigins.id, originId));
    expect(schedule!.nextFetchAt!.getTime()).toBeLessThan(due.getTime());
    expect((await database.select().from(atprotoStreamState))[0]).toMatchObject(
      { seq: "2" },
    );
  } finally {
    shutdown.abort();
  }
});

it("contacts no stream host and holds no lease while nothing follows the Atmosphere", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const shutdown = new AbortController();
  vi.mocked(resolveStreamService).mockClear();
  state.transport = undefined;
  const worker = startStreamWorker(database, shutdown.signal);
  // Long enough for the first look at the origins, which finds none.
  await new Promise((resolve) => setTimeout(resolve, 100));
  shutdown.abort();
  await worker;
  expect(resolveStreamService).not.toHaveBeenCalled();
  expect(await database.select().from(atprotoStreamState)).toEqual([]);
});

it("leaves covered origins as they are through an outage and resumes from the checkpoint when the host returns", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const shutdown = new AbortController();
  await liveReader(database, service, "did:plc:alice");
  const covered = new Date(Date.now() + 6 * 60 * 60 * 1000);
  await database.update(feedOrigins).set({ nextFetchAt: covered });
  const rows = () =>
    Promise.all([
      database.select().from(feedOrigins),
      database.select().from(feedOriginAtproto),
    ]);
  const before = await rows();
  const started = Date.now();
  let drops = 0;
  // Each drop comes 90 seconds after the last, so the outage runs for minutes.
  const clock = vi
    .spyOn(Date, "now")
    .mockImplementation(() => started + drops * 90_000);
  const resumedFrom: Array<number | undefined> = [];
  state.transport = {
    service,
    hasReplay: true,
    recover: vi.fn(),
    tip: vi.fn(async () => 1),
    report: vi.fn(),
    async *stream(after, _signal, _dids, onOpen) {
      resumedFrom.push(after);
      if (drops < 4) {
        drops++;
        // The socket opens, then drops before it delivers anything.
        await onOpen?.();
        throw new StreamFailure("connection-closed");
      }
      shutdown.abort();
      yield* [];
    },
  };
  try {
    await startStreamWorker(database, shutdown.signal);
    // No origin was made due or written to: polling could not reach the host either.
    expect(await rows()).toEqual(before);
    // An outage is not a gap: every connection resumes from the checkpoint.
    expect(resumedFrom).toEqual([1, 1, 1, 1, 1]);
    expect((await database.select().from(atprotoStreamState))[0]).toMatchObject(
      { generation: 0, seq: "1" },
    );
  } finally {
    clock.mockRestore();
    shutdown.abort();
  }
});

/** The reader's Feed with its hydrated origin, as the fetch pipeline hands it over. */
async function fetchableReader(
  database: NonNullable<typeof fixture>["database"],
) {
  const [feed] = await withOrigins(
    database,
    await database.select().from(feeds),
  );
  return { feed: feed!, origin: feed!.origins[0]! };
}
const unreachableTransport = (failure: Error): StreamTransport => ({
  service: "https://jetstream.example.com",
  hasReplay: false,
  recover: vi.fn(),
  tip: vi.fn(async () => {
    throw failure;
  }),
  report: vi.fn(),
  // eslint-disable-next-line require-yield
  async *stream() {
    throw failure;
  },
});

it("skips a fetch that cannot reach the stream host, without an error or a recorded failure", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  await liveReader(database, service, "did:plc:alice");
  const before = await database.select().from(feedOriginAtproto);
  state.transport = unreachableTransport(new StreamFailure("connection"));
  const refresh = await refreshStreamOrigin(
    database,
    await fetchableReader(database),
  );
  // The fetch pipeline shows a skipped origin as nothing and waits an hour.
  expect(refresh.result.status).toBe("skipped");
  expect(refresh.outcome).toEqual({ status: "unreachable" });
  // Still live, with no failed attempt and no backoff of its own.
  expect(await database.select().from(feedOriginAtproto)).toEqual(before);
  expect(state.transport.report).toHaveBeenCalledTimes(1);
});

it("skips a fetch whose stream boundary cannot be read from an unreachable host", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  await liveReader(database, service, "did:plc:alice");
  // A declared gap cleared the checkpoint, and the host went away before a new one.
  await database.update(atprotoStreamState).set({ seq: null });
  const before = await database.select().from(feedOriginAtproto);
  state.transport = unreachableTransport(new StreamFailure("connection", 502));
  const refresh = await refreshStreamOrigin(
    database,
    await fetchableReader(database),
  );
  expect(refresh.result.status).toBe("skipped");
  expect(refresh.outcome).toEqual({ status: "unreachable" });
  expect(await database.select().from(feedOriginAtproto)).toEqual(before);
});

it.each([
  ["a refused position", new StreamFailure("cursor-expired", 400)],
  ["a rate limit", new StreamFailure("connection", 429, 120_000)],
])("keeps %s a failed fetch", async (_, failure) => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  await liveReader(database, "https://jetstream.example.com", "did:plc:alice");
  state.transport = unreachableTransport(failure);
  const refresh = await refreshStreamOrigin(
    database,
    await fetchableReader(database),
  );
  expect(refresh.result.status).toBe("error");
  expect(refresh.outcome.status).toBe("deferred");
  expect(
    (await database.select().from(feedOriginAtproto).get())?.recoveryAttempts,
  ).toBe(1);
});

it("keeps a host that answered and then dropped a failed fetch that follows its backoff", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  await liveReader(database, service, "did:plc:alice");
  state.transport = {
    service,
    // With replay, an origin that has its documents catches up without a scan.
    hasReplay: true,
    tip: vi.fn(async () => 5),
    // eslint-disable-next-line require-yield
    async *recover() {
      throw new StreamFailure("connection");
    },
    report: vi.fn(),
    async *stream() {},
  };
  const refresh = await refreshStreamOrigin(
    database,
    await fetchableReader(database),
  );
  // Recovery recorded the failure, so the fetch shows it and waits its backoff.
  expect(state.transport.tip).toHaveBeenCalledTimes(1);
  expect(refresh.result.status).toBe("error");
  const origin = await database.select().from(feedOriginAtproto).get();
  expect(origin?.recoveryAttempts).toBe(1);
  expect(origin?.recoveryRetryAt?.getTime()).toBeGreaterThan(Date.now());
  expect(refresh.outcome).toEqual({
    status: "deferred",
    retryAt: origin?.recoveryRetryAt,
  });
});

it("leaves a Feed out of error when its backstop fetch finds the stream host unreachable", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  await liveReader(database, "https://jetstream.example.com", "did:plc:alice");
  const before = await database.select().from(feedOriginAtproto);
  state.transport = unreachableTransport(new StreamFailure("connection"));
  vi.mocked(publisher.publish).mockClear();
  vi.mocked(captureException).mockClear();
  const fetchable = await fetchableReader(database);
  const started = Date.now();
  const stats = await refreshUserFeeds({
    db: database,
    feedsList: [fetchable],
    channel: "reader",
  });
  const finished = Date.now();
  // The fetch reached for the host; it was not passed over as not yet due.
  expect(state.transport.tip).toHaveBeenCalledTimes(1);
  // A failed Feed is counted, named, captured and published as an error.
  expect(stats).toMatchObject({
    errorCount: 0,
    originFailureFeedIds: [],
    skippedCount: 1,
  });
  expect(captureException).not.toHaveBeenCalled();
  expect(vi.mocked(publisher.publish).mock.calls).toEqual([
    [
      "reader",
      {
        source: "rss",
        chunk: {
          type: "feed-status",
          status: "skipped",
          feedId: fetchable.feed.id,
        },
      },
    ],
  ]);
  // Nothing about the origin is recorded, and the schedule asks again in an hour.
  expect(await database.select().from(feedOriginAtproto)).toEqual(before);
  const next = (await database.select().from(feedOrigins).get())!.nextFetchAt!;
  expect(next.getTime()).toBeGreaterThanOrEqual(
    Math.floor((started + STREAM_HOST_RECHECK_MS) / 1000) * 1000,
  );
  expect(next.getTime()).toBeLessThanOrEqual(finished + STREAM_HOST_RECHECK_MS);
});

it("keeps an unreachable host a fetch error for a Feed that has no documents yet", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  await liveReader(database, "https://jetstream.example.com", "did:plc:alice");
  await database
    .update(feedOriginAtproto)
    .set({ initialized: false, streamMode: "paused", streamSeq: null });
  state.transport = unreachableTransport(new StreamFailure("connection"));
  const refresh = await refreshStreamOrigin(
    database,
    await fetchableReader(database),
  );
  // A new Feed saved during an outage keeps the existing fetch error and retry.
  expect(refresh.result.status).toBe("error");
  const origin = await database.select().from(feedOriginAtproto).get();
  expect(origin?.recoveryAttempts).toBe(1);
  expect(refresh.outcome).toEqual({
    status: "deferred",
    retryAt: origin?.recoveryRetryAt,
  });
});

it("follows a Publication created mid-stream and replays every event it skipped, in order", async () => {
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  const service = "https://jetstream.example.com";
  const shutdown = new AbortController();
  await liveReader(database, service, "did:plc:alice");
  const newcomer = "did:plc:newcomer";
  let joined = 0;
  state.transport = {
    service,
    hasReplay: true,
    recover: vi.fn(),
    tip: vi.fn(async () => 1),
    report: vi.fn(),
    async *stream(_after, _signal, _dids, onOpen) {
      await onOpen?.();
      const feed = await insertFeedWithOrigins(database, {
        userId: "reader",
        isActive: true,
        details: {
          name: "Newcomer",
          platform: "website",
          imageUrl: "",
          origins: [
            {
              kind: "atproto",
              locator: `at://${newcomer}/site.standard.publication/site`,
            },
          ],
        },
      });
      joined = feed.origins[0]!.id;
      await database
        .update(feedOriginAtproto)
        .set({ streamService: service, streamSeq: "1", streamMode: "catchup" })
        .where(eq(feedOriginAtproto.originId, joined));
      yield { events: [documentEvent(2, newcomer, "a")], lastCursor: 2 };
      yield {
        events: [documentEvent(3, "did:plc:stranger", "x")],
        lastCursor: 3,
      };
      yield { events: [documentEvent(4, newcomer, "b")], lastCursor: 4 };
      shutdown.abort();
    },
  };
  try {
    await startStreamWorker(database, shutdown.signal);
    expect(
      (
        await database
          .select()
          .from(feedOriginAtprotoDocuments)
          .where(eq(feedOriginAtprotoDocuments.originId, joined))
      )
        .map((document) => document.eventSeq)
        .sort(),
    ).toEqual(["2", "4"]);
    // Nobody follows the stranger, so its event reached no origin.
    expect(
      await database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(2);
    expect((await database.select().from(atprotoStreamState))[0]?.seq).toBe(
      "4",
    );
  } finally {
    shutdown.abort();
  }
});

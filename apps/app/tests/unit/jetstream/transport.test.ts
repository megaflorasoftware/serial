import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamTransport,
  liveTransport,
  retryStream,
} from "~/server/jetstream/transport";
import { createStreamReporter } from "~/server/jetstream/report";
import { forgetOutage } from "~/server/jetstream/reachability";
import {
  normalizeService,
  retryAfter,
  sequence,
  StreamFailure,
} from "~/server/jetstream/protocol";
import { captureException } from "~/server/logger";

vi.mock("~/server/logger", () => ({ captureException: vi.fn() }));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
const plan = (through: number) => ({
  sealedTipSeq: through,
  plannedThroughSeq: through,
  segments: [],
  stats: {
    segmentsExamined: 0,
    segmentsMatched: 0,
    blocksMatched: 0,
    entries: 0,
  },
});
describe("Jetstream transport", () => {
  it("normalizes checkpoint identity and rejects credentials and non-service URL components", () => {
    expect(normalizeService("https://EXAMPLE.com:443/")).toBe(
      "https://example.com",
    );
    for (const url of [
      "ftp://example.com",
      "https://key@example.com",
      "https://example.com?key=secret",
      "https://example.com/#fragment",
    ])
      expect(() => normalizeService(url)).toThrow();
    expect(() => sequence(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it("finishes an empty archive interval from the completed plan watermark", async () => {
    const fetch = vi.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) => {
        void _request;
        void _init;
        return Response.json(plan(1000));
      },
    );
    const transport = createStreamTransport({
      service: "https://example.com",
      apiKey: "test-replay-key",
      fetch,
    });
    const batches = [];
    for await (const batch of transport.recover(
      10,
      1000,
      new AbortController().signal,
      "did:plc:alice",
    ))
      batches.push(batch);
    expect(batches).toEqual([{ events: [], lastCursor: 1000 }]);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.headers).toBeDefined();
  });
  it("reports replay HTTP errors with sanitized context and honors the entire Retry-After", async () => {
    const transport = createStreamTransport({
      service: "https://example.com",
      apiKey: "test-replay-key",
      fetch: async () =>
        new Response("secret payload", {
          status: 429,
          headers: { "Retry-After": "120" },
        }),
    });
    let failure: unknown;
    try {
      for await (const batch of transport.recover(
        1,
        100,
        new AbortController().signal,
      ))
        void batch;
    } catch (error) {
      failure = error;
    }
    transport.report(failure, "consumer");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]?.[1]).toMatchObject({
      operation: "replay-http",
      service: "https://example.com",
      status: 429,
    });
    expect(
      JSON.stringify(vi.mocked(captureException).mock.calls),
    ).not.toContain("test-replay-key");
    const controller = new AbortController();
    controller.abort();
    await expect(
      retryStream(failure, 0, controller.signal),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(retryAfter("120")).toBe(120_000);
  });
  it("reports a nested failure once and excludes expected cancellation", () => {
    const report = createStreamReporter("https://example.com");
    const failure = new StreamFailure("download", 503);
    report(failure, "download");
    report(
      new Error("contains sensitive details", { cause: failure }),
      "consumer",
    );
    report(new DOMException("Cancelled", "AbortError"), "shutdown");
    expect(captureException).toHaveBeenCalledTimes(1);
  });
  it("reads v2 live frames, resumes using the persisted sequence and asks for no identity events", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({
      server,
      handleProtocols: () => "xrpc.v1.json",
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    let cursor: string | null = null;
    let kinds: string[] = [];
    sockets.on("connection", (socket, request) => {
      const requested = new URL(request.url!, "http://localhost").searchParams;
      cursor = requested.get("cursor");
      kinds = requested.getAll("kinds");
      socket.send(
        JSON.stringify({
          $type: "message",
          payload: {
            $type: "network.bsky.jetstream.subscribeEvents#account",
            seq: 11,
            did: "did:plc:alice",
            time: "2026-09-18T12:00:00Z",
            account: { did: "did:plc:alice", active: true },
          },
        }),
      );
    });
    const controller = new AbortController();
    try {
      const transport = createStreamTransport({
        service: `http://127.0.0.1:${address.port}`,
      });
      for await (const batch of transport.stream(10, controller.signal)) {
        expect(batch.events[0]).toMatchObject({
          seq: 11,
          kind: "account",
          account: { active: true },
        });
        break;
      }
      expect(cursor).toBe("10");
      expect(kinds).toEqual(["commit", "account", "sync"]);
    } finally {
      controller.abort();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())),
      );
    }
  });
  it("fails a tip at once while an outage is remembered, until a delivered batch forgets it", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({
      noServer: true,
      handleProtocols: () => "xrpc.v1.json",
    });
    let down = true;
    let attempts = 0;
    server.on("upgrade", (request, socket, head) => {
      attempts++;
      if (down) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => {
        client.send(
          JSON.stringify({
            $type: "message",
            payload: {
              $type: "network.bsky.jetstream.subscribeEvents#account",
              seq: 11,
              did: "did:plc:alice",
              time: "2026-09-18T12:00:00Z",
              account: { did: "did:plc:alice", active: true },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const transport = createStreamTransport({
      service: `http://127.0.0.1:${address.port}`,
    });
    const signal = new AbortController().signal;
    const controller = new AbortController();
    try {
      const first: unknown = await transport
        .tip(signal)
        .catch((error: unknown) => error);
      expect(first).toMatchObject({ operation: "connection", status: 503 });
      // The next read opens no connection and fails as the first did.
      expect(await transport.tip(signal).catch((error: unknown) => error)).toBe(
        first,
      );
      expect(attempts).toBe(1);
      // The worker's own connection is a contact, and this one succeeds.
      down = false;
      for await (const batch of transport.stream(10, controller.signal)) {
        expect(batch.lastCursor).toBe(11);
        break;
      }
      expect(await transport.tip(signal)).toBe(11);
      expect(attempts).toBe(3);
    } finally {
      // A case that failed partway must not leave its outage remembered.
      forgetOutage(transport.service);
      controller.abort();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())),
      );
    }
  });
  it("surfaces connection failures including the server retry delay", async () => {
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 75\r\nContent-Length: 0\r\n\r\n",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    const transport = createStreamTransport({
      service: `http://127.0.0.1:${address.port}`,
    });
    try {
      await expect(
        transport.stream(10, new AbortController().signal).next(),
      ).rejects.toMatchObject({ status: 503, retryAfterMs: 75_000 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

it("normalizes both wire URLs into distinct checkpoint identities", () => {
  expect(normalizeService("wss://EXAMPLE.com/subscribe/")).toBe(
    "https://example.com/subscribe",
  );
  expect(
    normalizeService(
      "wss://example.com/xrpc/network.bsky.jetstream.subscribeEvents",
    ),
  ).toBe("https://example.com");
});

it("reads v1 commits, identities and accounts using timestamp cursors without archive access", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const start = 1_790_000_000_000_000;
  let requested: URL | undefined;
  const did = "did:plc:alice";
  const record = { $type: "site.standard.document", title: "Article" };
  sockets.on("connection", (socket, request) => {
    requested = new URL(request.url!, "http://localhost");
    expect(request.headers["sec-websocket-protocol"]).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    const commit = {
      operation: "create",
      collection: "site.standard.document",
      rkey: "post",
      rev: "2222222222222",
      cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
      record,
    };
    for (const [offset, payload] of [
      [0, { kind: "commit", commit }],
      [1, { kind: "commit", commit }],
      [2, { kind: "commit", commit: { ...commit, operation: "update" } }],
      [
        3,
        {
          kind: "commit",
          commit: {
            operation: "delete",
            collection: commit.collection,
            rkey: "post",
            rev: commit.rev,
          },
        },
      ],
      [4, { kind: "identity", identity: { did } }],
      [
        5,
        { kind: "account", account: { did, active: false, status: "deleted" } },
      ],
    ] as const)
      socket.send(JSON.stringify({ did, time_us: start + offset, ...payload }));
  });
  const fetch = vi.fn();
  const controller = new AbortController();
  try {
    const transport = createStreamTransport({
      service: `ws://127.0.0.1:${address.port}/subscribe`,
      apiKey: "unused",
      fetch,
    });
    expect(transport.hasReplay).toBe(false);
    const events = [];
    for await (const batch of transport.stream(start, controller.signal)) {
      events.push(...batch.events);
      if (events.length === 5) break;
    }
    expect(requested?.pathname).toBe("/subscribe");
    expect(requested?.searchParams.get("cursor")).toBe(String(start));
    expect(requested?.searchParams.getAll("wantedCollections")).toEqual([
      "site.standard.document",
      "site.standard.publication",
    ]);
    // The frozen legacy wire cannot filter by kind.
    expect(requested?.searchParams.has("kinds")).toBe(false);
    expect(events.map((event) => event.seq)).toEqual(
      [1, 2, 3, 4, 5].map((n) => start + n),
    );
    expect(events[0]).toMatchObject({
      kind: "commit",
      commit: { record },
      time: new Date((start + 1) / 1000).toISOString(),
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
});

it("reports a successful quiet connection before receiving any events", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({
    server,
    handleProtocols: () => "xrpc.v1.json",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const controller = new AbortController();
  const opened = vi.fn(async () => {
    controller.abort();
  });
  try {
    const transport = createStreamTransport({
      service: `http://127.0.0.1:${address.port}`,
    });
    expect(
      await transport.stream(10, controller.signal, undefined, opened).next(),
    ).toMatchObject({ done: true });
    expect(opened).toHaveBeenCalledTimes(1);
  } finally {
    controller.abort();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
});

it("keeps 64-bit integers from live frames and archived records", async () => {
  const { createRecordStash, lexToLossless } =
    await import("~/server/jetstream/transport");
  const { parseLosslessJson } = await import("@serial/standard-site");
  const stash = createRecordStash();
  const frame = `{"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit","seq":7,"did":"did:plc:alice","time":"2026-09-18T12:00:00Z","rev":"2222222222222","operation":"create","collection":"site.standard.document","rkey":"post","cid":"bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku","record":{"$type":"site.standard.document","views":9007199254740993,"nested":{"$link":"bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"}}}}`;
  stash.note(frame);
  expect(stash.take(7)).toBe(
    '{"$type":"site.standard.document","views":9007199254740993,"nested":{"$link":"bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"}}',
  );
  expect(stash.take(7)).toBeUndefined();
  stash.note(
    `{"did":"did:plc:alice","time_us":${Number.MAX_SAFE_INTEGER},"kind":"commit","commit":{"operation":"create","collection":"site.standard.document","rkey":"post","rev":"1","cid":"x","record":{"count":-9223372036854775808}}}`,
  );
  expect(stash.take(Number.MAX_SAFE_INTEGER)).toBe(
    '{"count":-9223372036854775808}',
  );
  stash.note("not json");
  stash.note(
    '{"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#account","seq":8}}',
  );
  expect(stash.take(8)).toBeUndefined();
  const { parseCid } = await import("@atproto/lex");
  const lossless = lexToLossless({
    big: 9007199254740993n,
    link: parseCid(
      "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    ),
    bytes: new Uint8Array([1, 2, 3]),
    list: [null, true, "text"],
  });
  expect(lossless).toEqual({
    big: 9007199254740993n,
    link: {
      $link: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    },
    bytes: { $bytes: "AQID" },
    list: [null, true, "text"],
  });
  expect(parseLosslessJson(JSON.stringify({ n: 1 }))).toEqual({ n: 1 });
});

it("carries lossless record text on decoded live commits", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({
    server,
    handleProtocols: () => "xrpc.v1.json",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  sockets.on("connection", (socket) => {
    socket.send(
      `{"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit","seq":11,"did":"did:plc:alice","time":"2026-09-18T12:00:00Z","rev":"2222222222222","operation":"create","collection":"site.standard.document","rkey":"post","cid":"bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku","record":{"$type":"site.standard.document","title":"Article","views":9007199254740993}}}`,
    );
  });
  const controller = new AbortController();
  try {
    const transport = createStreamTransport({
      service: `http://127.0.0.1:${address.port}`,
    });
    for await (const batch of transport.stream(10, controller.signal)) {
      const event = batch.events[0];
      if (event?.kind !== "commit") throw new Error("expected a commit");
      expect(event.commit.recordText).toBe(
        '{"$type":"site.standard.document","title":"Article","views":9007199254740993}',
      );
      expect(event.commit.record).toEqual({
        $type: "site.standard.document",
        title: "Article",
        views: 9007199254740993n,
      });
      break;
    }
  } finally {
    controller.abort();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
});

it("slows a host that outpaces its reader instead of overflowing the buffer", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  // 12 MiB at once, past the 8 MiB the transport buffers.
  const frame = "x".repeat(64 * 1024);
  const frames = 192;
  sockets.on("connection", (socket) => {
    for (let index = 0; index < frames; index++) socket.send(frame);
  });
  const controller = new AbortController();
  let received = 0;
  try {
    for await (const message of liveTransport(true).stream(
      () => `ws://127.0.0.1:${address.port}`,
      controller.signal,
    )) {
      // The reader starts late: by then the host has sent all the socket takes.
      if (received === 0)
        await new Promise((resolve) => setTimeout(resolve, 250));
      expect(message).toHaveLength(frame.length);
      if (++received === frames) break;
    }
    expect(received).toBe(frames);
  } finally {
    controller.abort();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
});

describe("unreadable live messages", () => {
  /** A stream host that sends the same frames to every connection. */
  async function hostSending(frames: string[]) {
    const server = createServer();
    const sockets = new WebSocketServer({
      server,
      handleProtocols: () => "xrpc.v1.json",
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error();
    let connections = 0;
    sockets.on("connection", (socket) => {
      connections++;
      for (const frame of frames) socket.send(frame);
    });
    return {
      service: `http://127.0.0.1:${address.port}`,
      connections: () => connections,
      async close() {
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve) =>
          sockets.close(() => server.close(() => resolve())),
        );
      },
    };
  }
  const account = (seq: number, did: string, changes: object = {}) =>
    JSON.stringify({
      $type: "message",
      payload: {
        $type: "network.bsky.jetstream.subscribeEvents#account",
        seq,
        did,
        time: "2026-09-18T12:00:00Z",
        account: { did, active: true },
        ...changes,
      },
    });
  const commit = (seq: number, did: string, changes: object = {}) =>
    JSON.stringify({
      $type: "message",
      payload: {
        $type: "network.bsky.jetstream.subscribeEvents#commit",
        seq,
        did,
        time: "2026-09-18T12:00:00Z",
        rev: "2222222222222",
        operation: "create",
        collection: "site.standard.document",
        rkey: "post",
        cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
        record: { $type: "site.standard.document", title: "Article" },
        ...changes,
      },
    });
  /** Reads one connection until it delivers `through`. */
  async function read(
    service: string,
    through: number,
    transport = createStreamTransport({ service }),
  ) {
    const controller = new AbortController();
    const unreadable = vi.fn<(publisher: string) => void>();
    const batches: Array<{ seqs: number[]; lastCursor: number }> = [];
    try {
      for await (const batch of transport.stream(
        10,
        controller.signal,
        undefined,
        undefined,
        unreadable,
      )) {
        batches.push({
          seqs: batch.events.map((event) => event.seq),
          lastCursor: batch.lastCursor,
        });
        if (batch.lastCursor >= through) break;
      }
    } finally {
      controller.abort();
    }
    return { batches, unreadable };
  }
  const reports = () =>
    vi.mocked(captureException).mock.calls.map(([, context]) => context);

  it("passes over a message that fails a format check and names its publisher", async () => {
    const host = await hostSending([
      account(11, "did:plc:alice"),
      account(12, "did:plc:bob", { time: "yesterday" }),
      account(13, "did:plc:alice"),
    ]);
    try {
      const { batches, unreadable } = await read(host.service, 13);
      // The skipped message still moves the position forward.
      expect(batches).toEqual([
        { seqs: [11], lastCursor: 11 },
        { seqs: [], lastCursor: 12 },
        { seqs: [13], lastCursor: 13 },
      ]);
      expect(unreadable.mock.calls).toEqual([["did:plc:bob"]]);
      expect(host.connections()).toBe(1);
      expect(reports()).toMatchObject([{ operation: "message-decode" }]);
    } finally {
      await host.close();
    }
  });

  it("passes over a commit whose record key Serial does not accept", async () => {
    const host = await hostSending([
      commit(11, "did:plc:alice"),
      // The library reads this one; the event schema turns it away.
      commit(12, "did:plc:bob", { rkey: "not/a/key" }),
      commit(13, "did:plc:alice"),
    ]);
    try {
      const { batches, unreadable } = await read(host.service, 13);
      expect(batches).toEqual([
        { seqs: [11], lastCursor: 11 },
        { seqs: [], lastCursor: 12 },
        { seqs: [13], lastCursor: 13 },
      ]);
      expect(unreadable.mock.calls).toEqual([["did:plc:bob"]]);
      expect(host.connections()).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("reports a later unreadable message once a minute has passed", async () => {
    const host = await hostSending([
      account(11, "did:plc:bob", { time: "yesterday" }),
      account(12, "did:plc:alice"),
    ]);
    const now = vi.spyOn(Date, "now");
    try {
      const transport = createStreamTransport({ service: host.service });
      const start = 1_800_000_000_000;
      now.mockReturnValue(start);
      await read(host.service, 12, transport);
      now.mockReturnValue(start + 59_000);
      await read(host.service, 12, transport);
      expect(reports()).toHaveLength(1);
      now.mockReturnValue(start + 60_000);
      await read(host.service, 12, transport);
      expect(reports()).toHaveLength(2);
    } finally {
      now.mockRestore();
      await host.close();
    }
  });

  it("passes over messages the stream library cannot decode and reports the run once", async () => {
    const host = await hostSending([
      account(11, "did:plc:alice"),
      "not json",
      // Without `active` the library will not guess whether the account is deactivated.
      account(12, "did:plc:carol", { account: { did: "did:plc:carol" } }),
      account(13, "did:plc:dave", { account: undefined }),
      account(14, "did:plc:alice"),
    ]);
    try {
      const { batches, unreadable } = await read(host.service, 14);
      expect(batches).toEqual([
        { seqs: [11], lastCursor: 11 },
        { seqs: [14], lastCursor: 14 },
      ]);
      // The frame that is not JSON names nobody.
      expect(unreadable.mock.calls).toEqual([
        ["did:plc:carol"],
        ["did:plc:dave"],
      ]);
      expect(host.connections()).toBe(1);
      expect(reports()).toMatchObject([{ operation: "message-decode" }]);
    } finally {
      await host.close();
    }
  });

  it("passes over an unreadable legacy message", async () => {
    const start = 1_790_000_000_000_000;
    const legacy = (offset: number, did: string, payload: object) =>
      JSON.stringify({ did, time_us: start + offset, ...payload });
    const active = { kind: "account", account: { active: true } };
    const host = await hostSending([
      legacy(1, "did:plc:alice", active),
      legacy(2, "did:plc:bob", { kind: "account" }),
      legacy(3, "did:plc:alice", active),
    ]);
    try {
      const { batches, unreadable } = await read(
        `${host.service}/subscribe`,
        start + 3,
      );
      expect(batches.map((batch) => batch.lastCursor)).toEqual([
        start + 1,
        start + 3,
      ]);
      expect(unreadable.mock.calls).toEqual([["did:plc:bob"]]);
      expect(host.connections()).toBe(1);
    } finally {
      await host.close();
    }
  });

  it.each([
    ["v2", "", { $type: "error" }, "XrpcSubscriptionError"],
    ["legacy", "/subscribe", {}, "MalformedError"],
  ])(
    "still ends the connection on the %s host's own error frame",
    async (_version, path, shape, name) => {
      const host = await hostSending([
        JSON.stringify({ ...shape, error: "ConsumerTooSlow", message: "slow" }),
        account(11, "did:plc:alice"),
      ]);
      try {
        await expect(read(`${host.service}${path}`, 11)).rejects.toMatchObject({
          name,
        });
        expect(reports()).toEqual([]);
      } finally {
        await host.close();
      }
    },
  );
});

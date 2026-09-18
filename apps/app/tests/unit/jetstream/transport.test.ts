import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamTransport,
  retryStream,
} from "~/server/jetstream/transport";
import { createStreamReporter } from "~/server/jetstream/report";
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
  it("reads v2 live frames and resumes using the persisted sequence", async () => {
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
    sockets.on("connection", (socket, request) => {
      cursor = new URL(request.url!, "http://localhost").searchParams.get(
        "cursor",
      );
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
    } finally {
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

import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { Jetstream, parseRawRecord } from "@bsky/jetstream";
import { lexToJson } from "@atproto/lex";
import {
  COLLECTIONS,
  eventSchema,
  normalizeService,
  retryAfter,
  sequence,
  StreamFailure,
  streamFailure,
} from "./protocol";
import { createStreamReporter } from "./report";
import type { EventBatch, LiveTransport, RawEvent } from "@bsky/jetstream";
import type { StreamBatch } from "./protocol";

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** No hidden reconnects: the caller resumes from durable, applied progress. */
export function liveTransport(): LiveTransport {
  return {
    async *stream(getUrl, signal, options) {
      const socket = new WebSocket(getUrl(), "xrpc.v1.json", {
        headers: Object.fromEntries(new Headers(options?.headers)),
        maxPayload: 32 * 1024 * 1024,
        handshakeTimeout: 30_000,
      });
      const queue: string[] = [];
      let bytes = 0;
      let ended = false;
      let failure: Error | undefined;
      let wake = () => {};
      const fail = (error: Error) => {
        failure ??= error;
        ended = true;
        wake();
        socket.terminate();
      };
      const abort = () => {
        ended = true;
        wake();
        socket.terminate();
      };
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        fail(
          new StreamFailure(
            "connection",
            response.statusCode,
            retryAfter(String(response.headers["retry-after"] ?? "")),
          ),
        );
      });
      socket.on("error", () => fail(new StreamFailure("connection")));
      socket.on("close", () => {
        ended = true;
        wake();
      });
      socket.on("message", (data) => {
        const message = data.toString();
        bytes += Buffer.byteLength(message);
        if (bytes > MAX_BUFFER_BYTES) {
          fail(new StreamFailure("live-buffer"));
          return;
        }
        queue.push(message);
        wake();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        while (!signal.aborted) {
          if (failure) throw failure;
          const next = queue.shift();
          if (next !== undefined) {
            bytes -= Buffer.byteLength(next);
            yield next;
            continue;
          }
          if (ended) throw new StreamFailure("connection-closed");
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        signal.removeEventListener("abort", abort);
        socket.terminate();
      }
    },
  };
}

export type StreamTransport = ReturnType<typeof createStreamTransport>;
export function createStreamTransport(input: {
  service: string;
  apiKey?: string;
  fetch?: typeof fetch;
}) {
  const service = normalizeService(input.service);
  const report = createStreamReporter(service);
  const fetchImpl: typeof fetch = async (request, init) => {
    const signal =
      init?.signal ?? (request instanceof Request ? request.signal : undefined);
    try {
      const response = await (input.fetch ?? fetch)(request, {
        ...init,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(60_000),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new StreamFailure(
          "replay-http",
          response.status,
          retryAfter(response.headers.get("retry-after")),
        );
      }
      return response;
    } catch (error) {
      if (!signal?.aborted) report(error, "replay-http");
      throw error;
    }
  };
  const sdk = new Jetstream({
    service,
    apiKey: input.apiKey,
    fetchImpl,
    validateWire: true,
    retry: {
      maxAttempts: 1,
      onRetry: (error) => report(error, "replay-download"),
    },
    blockConcurrency: 2,
    snapshotBufferBytes: 4 * 1024 * 1024,
  });
  async function* decode(
    batches: AsyncIterable<EventBatch<RawEvent>>,
  ): AsyncGenerator<StreamBatch> {
    for await (const batch of batches) {
      const events = batch.events.flatMap((raw) => {
        try {
          const event =
            raw.kind === "commit" && raw.commit.operation !== "delete"
              ? {
                  ...raw,
                  commit: {
                    ...raw.commit,
                    record: lexToJson(parseRawRecord(raw.commit.record)),
                  },
                }
              : raw;
          return [eventSchema.parse(event)];
        } catch (error) {
          report(error, "record-decode");
          // Persist an invalid latest version, retiring older pending work for this key.
          if (raw.kind === "commit") {
            return [
              eventSchema.parse({
                ...raw,
                commit: { ...raw.commit, record: null },
              }),
            ];
          }
          throw error;
        }
      });
      yield { events, lastCursor: sequence(batch.lastCursor) };
    }
  }
  function options(signal: AbortSignal) {
    return {
      collections: COLLECTIONS,
      signal,
      liveTransport: liveTransport(),
      onError: (error: Error) => {
        if (!signal.aborted) report(error, "replay-decode");
      },
      onInfo: (info: { name: string }) => {
        if (info.name === "OutdatedCursor")
          throw new StreamFailure("cursor-expired", 400);
      },
    };
  }
  async function* archive(
    after: number,
    before: number | undefined,
    signal: AbortSignal,
    dids?: string[],
  ) {
    let plannedThrough = after;
    // The SDK does not yield an empty plan's watermark. Observe it per iterator,
    // and expose it only after every download in that snapshot has completed.
    const snapshot = new Jetstream({
      ...sdk.opts,
      fetchImpl: async (request, init) => {
        const response = await fetchImpl(request, init);
        const url = request instanceof Request ? request.url : String(request);
        if (
          new URL(url).pathname.endsWith("/network.bsky.jetstream.planSnapshot")
        ) {
          const plan = (await response.clone().json()) as {
            plannedThroughSeq: unknown;
          };
          plannedThrough = Math.max(
            plannedThrough,
            sequence(Number(plan.plannedThroughSeq)),
          );
        }
        return response;
      },
    });
    for await (const batch of decode(
      snapshot.snapshotRawBatches({
        ...options(signal),
        afterSeq: after,
        beforeSeq: before,
        maxReplans: 0,
        dids: dids as Array<`did:${string}:${string}`> | undefined,
      }),
    )) {
      yield {
        events: batch.events,
        lastCursor:
          before === undefined
            ? batch.lastCursor
            : Math.min(before, batch.lastCursor),
      };
    }
    if (signal.aborted) throw signal.reason;
    yield {
      events: [],
      lastCursor:
        before === undefined
          ? plannedThrough
          : Math.min(before, plannedThrough),
    };
  }
  return {
    service,
    hasReplay: Boolean(input.apiKey),
    report,
    async *stream(
      after: number | undefined,
      signal: AbortSignal,
      dids?: string[],
    ): AsyncGenerator<StreamBatch> {
      let cursor = after;
      if (input.apiKey && after !== undefined) {
        for await (const batch of archive(after, undefined, signal, dids)) {
          cursor = Math.max(cursor ?? 0, batch.lastCursor);
          yield batch;
        }
      }
      yield* decode(
        sdk.liveRawBatches({
          ...options(signal),
          dids: dids as Array<`did:${string}:${string}`> | undefined,
          cursor: { load: async () => cursor, save: async () => {} },
        }),
      );
    },
    async tip(signal: AbortSignal) {
      const controller = new AbortController();
      try {
        for await (const batch of decode(
          sdk.liveRawBatches({
            ...options(AbortSignal.any([signal, controller.signal])),
          }),
        ))
          return batch.lastCursor;
        throw new StreamFailure("boundary");
      } finally {
        controller.abort();
      }
    },
    /** Replay filters archive blocks by publisher; the short live handoff reaches an exact global boundary. */
    async *recover(
      after: number,
      through: number,
      signal: AbortSignal,
      did?: string,
    ): AsyncGenerator<StreamBatch> {
      if (after >= through) return;
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      let cursor = after;
      try {
        if (input.apiKey) {
          for await (const batch of archive(
            cursor,
            through,
            combined,
            did ? [did] : undefined,
          )) {
            cursor = batch.lastCursor;
            yield batch;
            if (cursor >= through) return;
          }
        }
        for await (const batch of decode(
          sdk.liveRawBatches({
            ...options(combined),
            cursor: { load: async () => cursor, save: async () => {} },
          }),
        )) {
          yield {
            events: batch.events.filter((event) => event.seq <= through),
            lastCursor: Math.min(through, batch.lastCursor),
          };
          if (batch.lastCursor >= through) return;
        }
        if (!signal.aborted) throw new StreamFailure("incomplete-recovery");
      } finally {
        controller.abort();
      }
    },
  };
}

export async function retryStream(
  error: unknown,
  attempt: number,
  signal: AbortSignal,
) {
  const wait = streamFailure(error)?.retryAfterMs;
  await delay(
    wait ?? Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)),
    undefined,
    { signal },
  );
}

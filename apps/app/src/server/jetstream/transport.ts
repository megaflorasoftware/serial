import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { Jetstream, JetstreamV1, parseRawRecord } from "@bsky/jetstream";
import { isCid, toBase64 } from "@atproto/lex";
import {
  parseLosslessJson,
  stringifyLosslessJson,
} from "@serial/standard-site";
import { captureRecordText, captureRecordValue } from "./document-source";
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
import type {
  EventBatch,
  LiveTransport,
  RawEvent,
  RawEventV1,
  RawRecord,
} from "@bsky/jetstream";
import type { StreamBatch } from "./protocol";
import { isLegacyJetstream } from "~/lib/jetstream-endpoint";

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_STASHED_RECORDS = 4096;

/**
 * The SDK parses frames with `JSON.parse`, which rounds 64-bit integers. Each
 * commit's record is captured from the frame text first and matched back to
 * the decoded event by sequence.
 */
export function createRecordStash() {
  const texts = new Map<number, string>();
  return {
    note(frame: string) {
      let parsed: unknown;
      try {
        parsed = parseLosslessJson(frame);
      } catch {
        return; // The SDK reports malformed frames.
      }
      const located = locateCommitRecord(parsed);
      if (!located) return;
      if (texts.size >= MAX_STASHED_RECORDS)
        texts.delete(texts.keys().next().value!);
      texts.set(located.seq, stringifyLosslessJson(located.record));
    },
    take(seq: number) {
      const text = texts.get(seq);
      texts.delete(seq);
      return text;
    },
  };
}

type Frame = { [key: string]: unknown };

function asFrame(value: unknown): Frame | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Frame)
    : null;
}

/** v2 wraps the commit in `payload`; v1 carries it at the top level with `time_us`. */
function locateCommitRecord(frame: unknown) {
  const outer = asFrame(frame);
  if (!outer) return null;
  const payload = asFrame(outer.payload);
  if (payload && typeof payload.$type === "string") {
    if (!payload.$type.endsWith("#commit") || payload.record === undefined)
      return null;
    return { seq: Number(payload.seq), record: payload.record };
  }
  const commit = asFrame(outer.commit);
  if (outer.kind !== "commit" || !commit || commit.record === undefined)
    return null;
  return { seq: Number(outer.time_us), record: commit.record };
}

/** Lex values from DAG-CBOR keep integers as bigint and links and bytes as their JSON forms. */
export function lexToLossless(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(lexToLossless);
  if (isCid(value)) return { $link: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, lexToLossless(entry)]),
  );
}

/** No hidden reconnects: the caller resumes from durable, applied progress. */
export function liveTransport(
  legacy = false,
  onOpen?: () => Promise<void>,
  onFrame?: (frame: string) => void,
): LiveTransport {
  return {
    async *stream(getUrl, signal, options) {
      const socket = new WebSocket(getUrl(), legacy ? [] : ["xrpc.v1.json"], {
        headers: Object.fromEntries(new Headers(options?.headers)),
        maxPayload: 32 * 1024 * 1024,
        handshakeTimeout: 30_000,
      });
      const queue: string[] = [];
      let bytes = 0;
      let ended = false;
      let failure: Error | undefined;
      let opening: Promise<void> | undefined;
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
      socket.on("open", () => {
        if (ended || signal.aborted || !onOpen) return;
        opening = onOpen().then(
          () => {
            wake();
          },
          (error: unknown) =>
            fail(
              error instanceof Error
                ? error
                : new StreamFailure("connection-open"),
            ),
        );
      });
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
        onFrame?.(message);
        queue.push(message);
        wake();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        while (!signal.aborted) {
          await opening;
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
        await opening;
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
  const legacy = isLegacyJetstream(service);
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
  const stash = createRecordStash();
  /** Wire JSON comes from the stash; archive CBOR is decoded and serialized losslessly. */
  function captureCommitRecord(seq: number, raw: RawRecord) {
    const captured =
      raw instanceof Uint8Array
        ? captureRecordValue(lexToLossless(parseRawRecord(raw)))
        : (() => {
            const text = stash.take(seq);
            return text ? captureRecordText(text) : captureRecordValue(raw);
          })();
    return { record: captured.value, recordText: captured.text };
  }
  async function* decode(
    batches: AsyncIterable<EventBatch<RawEvent | RawEventV1>>,
  ): AsyncGenerator<StreamBatch> {
    for await (const batch of batches) {
      const events = batch.events.flatMap((raw) => {
        const time =
          "time" in raw ? raw.time : new Date(raw.timeUs / 1000).toISOString();
        try {
          const event =
            raw.kind === "commit" && raw.commit.operation !== "delete"
              ? {
                  ...raw,
                  commit: {
                    ...raw.commit,
                    ...captureCommitRecord(raw.seq, raw.commit.record),
                  },
                }
              : raw;
          return [
            eventSchema.parse({
              ...event,
              time,
            }),
          ];
        } catch (error) {
          report(error, "record-decode");
          // Persist an invalid latest version, retiring older pending work for this key.
          if (raw.kind === "commit") {
            return [
              eventSchema.parse({
                ...raw,
                time,
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
  function options(signal: AbortSignal, onOpen?: () => Promise<void>) {
    return {
      collections: COLLECTIONS,
      signal,
      liveTransport: liveTransport(legacy, onOpen, stash.note),
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
  const v1 = new JetstreamV1({ service, validateWire: true });
  async function* live(
    after: number | undefined,
    signal: AbortSignal,
    dids?: string[],
    onOpen?: () => Promise<void>,
  ): AsyncGenerator<StreamBatch> {
    const opts = {
      ...options(signal, onOpen),
      dids: dids as Array<`did:${string}:${string}`> | undefined,
      cursor: { load: async () => after, save: async () => {} },
    };
    if (!legacy) {
      yield* decode(sdk.liveRawBatches(opts));
      return;
    }
    async function* batches() {
      for await (const event of v1.live({ ...opts, raw: true }))
        yield { events: [event], lastCursor: event.seq };
    }
    yield* decode(batches());
  }
  return {
    service,
    hasReplay: !legacy && Boolean(input.apiKey),
    report,
    async *stream(
      after: number | undefined,
      signal: AbortSignal,
      dids?: string[],
      onOpen?: () => Promise<void>,
    ): AsyncGenerator<StreamBatch> {
      // Archive recovery belongs to normal Feed fetching, never worker reconnect.
      yield* live(after, signal, dids, onOpen);
    },
    async tip(signal: AbortSignal) {
      const controller = new AbortController();
      try {
        for await (const batch of live(
          undefined,
          AbortSignal.any([signal, controller.signal]),
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
        if (!legacy && input.apiKey) {
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
        for await (const batch of live(cursor, combined)) {
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

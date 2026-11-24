import { setTimeout as delay } from "node:timers/promises";
import zlib from "node:zlib";
import WebSocket from "ws";
import {
  Jetstream,
  JetstreamV1,
  MalformedError,
  parseRawRecord,
  XrpcSubscriptionError,
} from "@bsky/jetstream";
import { isCid, toBase64 } from "@atproto/lex";
import {
  parseLosslessJson,
  stringifyLosslessJson,
} from "@serial/standard-site";
import { captureRecordText, captureRecordValue } from "./document-source";
import {
  ArchiveUnreadableError,
  COLLECTIONS,
  errorChain,
  eventSchema,
  normalizeService,
  retryAfter,
  sequence,
  STREAM_KINDS,
  StreamFailure,
  streamFailure,
} from "./protocol";
import { createStreamReporter } from "./report";
import {
  forgetOutage,
  hostUnreachable,
  recentOutage,
  rememberOutage,
} from "./reachability";
import type {
  Decompressor,
  EventBatch,
  LiveTransport,
  RawEvent,
  RawEventV1,
  RawRecord,
} from "@bsky/jetstream";
import type { StreamBatch } from "./protocol";
import { isLegacyJetstream } from "~/lib/jetstream-endpoint";

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Past this the socket stops reading, so the host holds what it has not sent. */
const PAUSE_BUFFER_BYTES = MAX_BUFFER_BYTES / 2;
const MAX_STASHED_RECORDS = 4096;
/** A run of unreadable messages reports this often, not once each. */
const UNREADABLE_REPORT_INTERVAL_MS = 60_000;

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

/** A frame as plain JSON, read without the checks it failed. */
function looseFrame(frame: string | undefined) {
  if (frame === undefined) return null;
  try {
    return asFrame(JSON.parse(frame));
  } catch {
    return null;
  }
}

/** v2 names the publisher inside `payload`; v1 at the top level. */
function framePublisher(frame: Frame | null) {
  return publisher((asFrame(frame?.payload) ?? frame)?.did);
}

function publisher(did: unknown) {
  return typeof did === "string" ? did : undefined;
}

/** zlib's codes for a block that is not zstd, is cut short or damaged, or inflates past its cap. */
function blockIsCorrupt(error: unknown) {
  const code =
    error instanceof Error && "code" in error ? error.code : undefined;
  return (
    typeof code === "string" &&
    code !== "ZSTD_error_memory_allocation" &&
    /^(ZSTD_error_|Z_BUF_ERROR$|Z_DATA_ERROR$|ERR_BUFFER_TOO_LARGE$)/.test(code)
  );
}

/**
 * The stream library names archive bytes it cannot decode `MalformedError`,
 * except a block that fails to decompress, which keeps zlib's own error. Here
 * a corrupt block gets the same name. Any other failure, such as a runtime
 * without zstd, stays what it was.
 */
const blockDecompressor: Decompressor = {
  decompress(frame, maxDecodedBytes) {
    try {
      const block = zlib.zstdDecompressSync(frame, {
        maxOutputLength: maxDecodedBytes,
      });
      // A plain view, as the library's own reader hands over.
      return new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
    } catch (error) {
      if (!blockIsCorrupt(error)) throw error;
      throw new MalformedError("decompress archive block", { cause: error });
    }
  },
};

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
  /** Sees each frame as the reader takes it, after `onFrame` saw it arrive. */
  onRead?: (frame: string) => void,
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
        // A reader that falls behind slows the host down instead of losing
        // the buffer to the failure above.
        if (bytes > PAUSE_BUFFER_BYTES) socket.pause();
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
            if (socket.isPaused && bytes <= PAUSE_BUFFER_BYTES) socket.resume();
            onRead?.(next);
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
  // The stream library's strict validation fails a whole read on the first
  // event it rejects. A live connection ends, and the host sends that frame
  // again after every reconnect; an archive read stops at the same block every
  // time. The readers pass such an event over instead, and `eventSchema`
  // checks the same formats on the fields Serial reads.
  const sdk = new Jetstream({
    service,
    apiKey: input.apiKey,
    fetchImpl,
    retry: {
      maxAttempts: 1,
      onRetry: (error) => report(error, "replay-download"),
    },
    blockConcurrency: 2,
    snapshotBufferBytes: 4 * 1024 * 1024,
    decompressor: blockDecompressor,
  });
  const legacySdk = new JetstreamV1({ service });
  let unreadableReportedAt = Number.NEGATIVE_INFINITY;
  function reportUnreadable(error: unknown) {
    const now = Date.now();
    if (now - unreadableReportedAt < UNREADABLE_REPORT_INTERVAL_MS) return;
    unreadableReportedAt = now;
    report(error, "message-decode");
  }
  /**
   * Passes over an event that cannot be read: it is reported, and
   * `onUnreadable` hears its publisher when the event still names one.
   */
  function passingOver(onUnreadable?: (publisher: string) => void) {
    return (error: unknown, did: string | undefined) => {
      reportUnreadable(error);
      if (did !== undefined) onUnreadable?.(did);
    };
  }
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
    skip: ReturnType<typeof passingOver>,
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
          // Persist an invalid latest version, retiring older pending work for this key.
          const invalid =
            raw.kind === "commit"
              ? eventSchema.safeParse({
                  ...raw,
                  time,
                  commit: { ...raw.commit, record: null },
                })
              : undefined;
          if (!invalid?.success) {
            skip(error, publisher(raw.did));
            return [];
          }
          report(error, "record-decode");
          return [invalid.data];
        }
      });
      yield { events, lastCursor: sequence(batch.lastCursor) };
    }
  }
  function options(signal: AbortSignal) {
    return {
      collections: COLLECTIONS,
      signal,
      onError: (error: Error) => {
        if (!signal.aborted) report(error, "replay-decode");
      },
      onInfo: (info: { name: string }) => {
        if (info.name === "OutdatedCursor")
          throw new StreamFailure("cursor-expired", 400);
      },
    };
  }
  /**
   * A read fails as `ArchiveUnreadableError` when the stream library could
   * not decode bytes it had downloaded. A failed plan or download keeps its
   * own failure, which a later read may not meet.
   */
  async function* archive(
    after: number,
    before: number | undefined,
    signal: AbortSignal,
    dids?: string[],
    onUnreadable?: (publisher: string) => void,
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
    try {
      for await (const batch of decode(
        snapshot.snapshotRawBatches({
          ...options(signal),
          afterSeq: after,
          beforeSeq: before,
          kinds: [...STREAM_KINDS],
          maxReplans: 0,
          dids: dids as Array<`did:${string}:${string}`> | undefined,
        }),
        passingOver(onUnreadable),
      )) {
        yield {
          events: batch.events,
          lastCursor:
            before === undefined
              ? batch.lastCursor
              : Math.min(before, batch.lastCursor),
        };
      }
    } catch (error) {
      // The stream library's name for bytes it downloaded and cannot decode.
      if (!errorChain(error).some((entry) => entry instanceof MalformedError))
        throw error;
      report(error, "archive-decode");
      throw new ArchiveUnreadableError(error);
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
  /**
   * A message that cannot be read is reported and passed over, so the
   * connection outlives it. `onUnreadable` hears its publisher when the
   * message still names one.
   */
  async function* live(
    after: number | undefined,
    signal: AbortSignal,
    dids?: string[],
    onOpen?: () => Promise<void>,
    onUnreadable?: (publisher: string) => void,
  ): AsyncGenerator<StreamBatch> {
    // The frame the reader holds, which a decode failure is about.
    let reading: string | undefined;
    const skip = passingOver(onUnreadable);
    const opts = {
      ...options(signal),
      liveTransport: liveTransport(legacy, onOpen, stash.note, (frame) => {
        reading = frame;
      }),
      onError: (error: Error) => {
        const frame = looseFrame(reading);
        // The host's own error frame ends the connection, as it always has.
        // v2's has its own error class; the legacy host's is a frame with
        // `error` set.
        if (error instanceof XrpcSubscriptionError || (legacy && frame?.error))
          throw error;
        skip(error, framePublisher(frame));
      },
      dids: dids as Array<`did:${string}:${string}`> | undefined,
      cursor: { load: async () => after, save: async () => {} },
    };
    if (!legacy) {
      yield* decode(
        sdk.liveRawBatches({ ...opts, kinds: [...STREAM_KINDS] }),
        skip,
      );
      return;
    }
    // The frozen legacy wire has no kind filter; it sends every kind.
    async function* batches() {
      for await (const event of legacySdk.live({ ...opts, raw: true }))
        yield { events: [event], lastCursor: event.seq };
    }
    yield* decode(batches(), skip);
  }
  /**
   * How a contact goes tells whether the host can be reached. A delivered
   * batch forgets an outage; a contact that fails before it delivers one, in
   * the way an unreachable host fails, is remembered.
   */
  async function* contacting(
    batches: AsyncIterable<StreamBatch>,
  ): AsyncGenerator<StreamBatch> {
    let delivered = false;
    try {
      for await (const batch of batches) {
        if (!delivered) forgetOutage(service);
        delivered = true;
        yield batch;
      }
    } catch (error) {
      if (!delivered && hostUnreachable(error)) rememberOutage(service, error);
      throw error;
    }
  }
  /** Replay filters archive blocks by publisher; the short live handoff reaches an exact global boundary. */
  async function* replayed(
    after: number,
    through: number,
    signal: AbortSignal,
    did?: string,
    onUnreadable?: (publisher: string) => void,
  ): AsyncGenerator<StreamBatch> {
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
          onUnreadable,
        )) {
          cursor = batch.lastCursor;
          yield batch;
          if (cursor >= through) return;
        }
      }
      for await (const batch of live(
        cursor,
        combined,
        undefined,
        undefined,
        onUnreadable,
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
      onUnreadable?: (publisher: string) => void,
    ): AsyncGenerator<StreamBatch> {
      // Archive recovery belongs to normal Feed fetching, never worker reconnect.
      yield* contacting(live(after, signal, dids, onOpen, onUnreadable));
    },
    /**
     * The host's newest position. While an outage is remembered this fails
     * at once with the failure that found it, without opening a connection.
     */
    async tip(signal: AbortSignal) {
      const outage = recentOutage(service);
      if (outage) throw outage.failure;
      const controller = new AbortController();
      try {
        for await (const batch of contacting(
          live(undefined, AbortSignal.any([signal, controller.signal])),
        ))
          return batch.lastCursor;
        throw new StreamFailure("boundary");
      } finally {
        controller.abort();
      }
    },
    /**
     * The interval's events, from the archive where there is one and the live
     * stream after it. `onUnreadable` hears the publisher of each event the
     * read passed over.
     */
    async *recover(
      after: number,
      through: number,
      signal: AbortSignal,
      did?: string,
      onUnreadable?: (publisher: string) => void,
    ): AsyncGenerator<StreamBatch> {
      if (after >= through) return;
      yield* contacting(replayed(after, through, signal, did, onUnreadable));
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

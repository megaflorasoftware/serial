import { z } from "zod";
import {
  isCidString,
  isDatetimeString,
  isDidString,
  isNsidString,
  isRecordKeyString,
  isTidString,
} from "@atproto/lex";

export const COLLECTIONS = [
  "site.standard.document",
  "site.standard.publication",
] as const;
/**
 * Identity events change nothing Serial stores, so a service that can filter
 * by kind is not asked for them. The collection filter covers commits only.
 */
export const STREAM_KINDS = ["commit", "account", "sync"] as const;
export const sequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
/** A string in a format the stream library's strict mode checks. */
const format = (valid: (value: string) => boolean) =>
  z.string().refine((value) => valid(value));
/**
 * The live reader skips a message it cannot decode, where the stream
 * library's strict mode would end the connection on it. The formats here are
 * the ones that mode checks on the fields Serial reads, so what Serial
 * accepts is the same either way.
 */
export const eventSchema = z
  .object({
    seq: sequenceSchema,
    did: format(isDidString),
    time: format(isDatetimeString),
  })
  .and(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("commit"),
        commit: z.object({
          operation: z.enum(["create", "update", "delete"]),
          collection: format(isNsidString),
          rkey: format(isRecordKeyString),
          rev: format(isTidString),
          cid: format(isCidString).optional(),
          record: z.unknown().optional(),
          /** Lossless JSON of `record`, captured before any rounding parse. */
          recordText: z.string().optional(),
        }),
      }),
      z.object({
        kind: z.literal("account"),
        account: z.object({
          active: z.boolean(),
          status: z.string().optional(),
        }),
      }),
      z.object({ kind: z.literal("identity"), identity: z.unknown() }),
      z.object({
        kind: z.literal("sync"),
        sync: z.object({ rev: format(isTidString) }),
      }),
    ]),
  );
export type StreamEvent = z.infer<typeof eventSchema>;
export type StreamBatch = { events: StreamEvent[]; lastCursor: number };
export function sequence(value: string | number) {
  return sequenceSchema.parse(
    typeof value === "string" ? Number(value) : value,
  );
}
export { normalizeJetstreamEndpoint as normalizeService } from "~/lib/jetstream-endpoint";
export class CheckpointHostError extends Error {
  constructor() {
    super("Jetstream checkpoint belongs to a different service");
  }
}
export class StreamFailure extends Error {
  constructor(
    readonly operation: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Jetstream ${operation} failed${status ? ` (${status})` : ""}`);
  }
}
export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function errorChain(error: unknown): object[] {
  const chain: object[] = [];
  const seen = new Set<object>();
  while (error !== null && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    chain.push(error);
    error = "cause" in error ? error.cause : undefined;
  }
  return chain;
}
export function streamFailure(error: unknown) {
  return errorChain(error).find(
    (entry): entry is StreamFailure => entry instanceof StreamFailure,
  );
}

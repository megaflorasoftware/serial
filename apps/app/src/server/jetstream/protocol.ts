import { z } from "zod";
import {
  isCidString,
  isDatetimeString,
  isDidString,
  isNsidString,
  isRecordKeyString,
  isTidString,
} from "@atproto/lex";
import { errorChain } from "~/server/errorChain";

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
 * The readers skip an event they cannot decode, where the stream library's
 * strict mode would fail the whole read on it. The formats here are the ones
 * that mode checks on the fields Serial reads, so Serial accepts the same
 * events either way.
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
/** Archive data this build cannot decode. Another read meets the same bytes. */
export class ArchiveUnreadableError extends Error {
  constructor(cause: unknown) {
    super("Jetstream archive data cannot be decoded", { cause });
  }
}
export function streamFailure(error: unknown) {
  return errorChain(error).find(
    (entry): entry is StreamFailure => entry instanceof StreamFailure,
  );
}
export function archiveUnreadable(error: unknown) {
  return errorChain(error).some(
    (entry) => entry instanceof ArchiveUnreadableError,
  );
}

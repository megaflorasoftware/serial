import { z } from "zod";

export const COLLECTIONS = [
  "site.standard.document",
  "site.standard.publication",
] as const;
export const sequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const eventSchema = z
  .object({
    seq: sequenceSchema,
    did: z.string().startsWith("did:"),
    time: z.string(),
  })
  .and(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("commit"),
        commit: z.object({
          operation: z.enum(["create", "update", "delete"]),
          collection: z.string(),
          rkey: z.string(),
          rev: z.string(),
          cid: z.string().optional(),
          record: z.unknown().optional(),
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
        sync: z.object({ rev: z.string() }),
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
export function normalizeService(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Jetstream service URL");
  return url.href.replace(/\/+$/, "");
}
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
  while (
    error !== null &&
    typeof error === "object" &&
    !chain.includes(error)
  ) {
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

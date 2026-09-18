import { eq } from "drizzle-orm";
import type { StreamDatabase, StreamSettings } from "~/server/jetstream/store";
import type { ProcessingOptions } from "~/server/jetstream/process";
import type { StreamTransport } from "~/server/jetstream/transport";
import { atprotoStreamState, feedOriginAtproto } from "~/server/db/schema";
import { recoverOrigin } from "~/server/jetstream/recovery";
import { processOriginDocuments } from "~/server/jetstream/process";
import { ensureStream } from "~/server/jetstream/store";

/** Drives repository recovery through the same staging and processing as the worker. */
export async function recoverRepository(
  database: StreamDatabase,
  originId: number,
  options: ProcessingOptions,
  direct = true,
) {
  const service = "https://jetstream.example.com";
  const state = await ensureStream(database, service);
  const seq = Number(state.seq ?? 0) + 1;
  await database
    .update(atprotoStreamState)
    .set({ seq: String(seq) })
    .where(eq(atprotoStreamState.service, service));
  if (direct)
    await database
      .update(feedOriginAtproto)
      .set({ streamMode: "direct", streamSeq: String(seq) })
      .where(eq(feedOriginAtproto.originId, originId));
  const settings: StreamSettings = {
    service,
    backgroundEnabled: true,
    getPlanId: async () => "pro",
    now: () => new Date("2026-09-18T12:00:00Z"),
  };
  const transport: StreamTransport = {
    service,
    hasReplay: false,
    report: () => {},
    tip: async () => seq,
    async *stream() {},
    async *recover() {
      yield { events: [], lastCursor: seq };
    },
  };
  if (!direct) {
    await processOriginDocuments(database, originId, settings, options);
    return;
  }
  await recoverOrigin(
    database,
    originId,
    settings,
    transport,
    new AbortController().signal,
    { manual: true, publish: async () => {}, ...options },
  );
}

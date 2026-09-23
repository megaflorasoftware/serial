import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { feedOriginAtproto } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { scanAtmosphere } from "../rss/scanAtmosphere";
import { createPublicationClient } from "../rss/atprotoClient";
import { CheckpointHostError, sequence, streamFailure } from "./protocol";
import {
  acceptBatch,
  eligible,
  ensureStream,
  loadOrigin,
  nowFor,
  planFor,
  stageDocuments,
  streamIsConnected,
} from "./store";
import { processOriginDocuments } from "./process";
import { captureRecordValue } from "./document-source";
import type { atprotoStreamState } from "../db/schema";
import type { StreamTransport } from "./transport";
import type { StreamDatabase, StreamSettings } from "./store";
import type { ProcessingOptions } from "./process";

/**
 * A connected worker already applies live events to this origin, so its
 * checkpoint bounds the interval no one covers. Otherwise the transport's tip
 * is the only truthful boundary, at the cost of one connection per read.
 */
async function currentBoundary(
  state: typeof atprotoStreamState.$inferSelect,
  transport: StreamTransport,
  settings: StreamSettings,
  signal: AbortSignal,
) {
  return transport.hasReplay || streamIsConnected(state, nowFor(settings))
    ? sequence(state.seq!)
    : transport.tip(signal);
}

/** A bounded attempt retains scan/replay progress. It never truncates the missed interval. */
export async function recoverOrigin(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
  transport: StreamTransport,
  signal: AbortSignal,
  options: ProcessingOptions = {},
) {
  const candidate = await loadOrigin(database, originId);
  if (
    candidate?.atproto.streamService &&
    candidate.atproto.streamService !== settings.service
  )
    throw new CheckpointHostError();
  if (
    candidate?.atproto.recoveryRetryAt &&
    candidate.atproto.recoveryRetryAt > nowFor(settings)
  )
    return;
  if (
    !candidate ||
    !eligible(
      candidate,
      await planFor(candidate, settings),
      settings,
      options.manual,
    )
  )
    return;
  const initialState = await ensureStream(database, settings.service);
  if (
    candidate.atproto.initialized &&
    candidate.atproto.streamMode === "live" &&
    candidate.atproto.streamGeneration === initialState.generation &&
    streamIsConnected(initialState, nowFor(settings))
  ) {
    await processOriginDocuments(database, originId, settings, options);
    return;
  }
  const owner = randomUUID();
  const now = nowFor(settings);
  const claimed = await runDatabaseWrite(database, () =>
    database
      .update(feedOriginAtproto)
      .set({ workOwner: owner, workUntil: new Date(now.getTime() + 60_000) })
      .where(
        and(
          eq(feedOriginAtproto.originId, originId),
          or(
            isNull(feedOriginAtproto.workUntil),
            lt(feedOriginAtproto.workUntil, now),
          ),
        ),
      )
      .returning({ originId: feedOriginAtproto.originId }),
  );
  if (!claimed.length) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const combined = AbortSignal.any([signal, controller.signal]);
  const heartbeat = setInterval(() => {
    void runDatabaseWrite(database, () =>
      database
        .update(feedOriginAtproto)
        .set({ workUntil: new Date(nowFor(settings).getTime() + 60_000) })
        .where(
          and(
            eq(feedOriginAtproto.originId, originId),
            eq(feedOriginAtproto.workOwner, owner),
          ),
        )
        .returning({ id: feedOriginAtproto.originId }),
    )
      .then((rows) => {
        if (!rows.length) controller.abort();
      })
      .catch(() => controller.abort());
  }, 15_000);
  const owned = and(
    eq(feedOriginAtproto.originId, originId),
    eq(feedOriginAtproto.workOwner, owner),
  )!;
  const processing = { ...options, signal: combined, workOwner: owner };
  try {
    combined.throwIfAborted();
    let row = await loadOrigin(database, originId);
    if (
      !row ||
      !eligible(row, await planFor(row, settings), settings, options.manual)
    )
      return;
    let state = await ensureStream(database, settings.service);
    if (state.seq === null)
      throw new Error("Waiting for a Jetstream bootstrap boundary");
    if (
      row.atproto.streamService &&
      row.atproto.streamService !== settings.service
    )
      throw new CheckpointHostError();
    // Persist the generation being recovered with its boundary across bounded attempts.
    const continuing =
      row.atproto.streamSeq !== null &&
      ["direct", "catchup"].includes(row.atproto.streamMode);
    const generation = continuing
      ? row.atproto.streamGeneration
      : state.generation;
    const bootstrap =
      !row.atproto.initialized ||
      (!transport.hasReplay && !continuing) ||
      row.atproto.streamMode === "direct";
    if (!continuing) {
      const boundary = bootstrap
        ? await currentBoundary(state, transport, settings, combined)
        : sequence(row.atproto.streamSeq ?? state.seq);
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({
            streamService: settings.service,
            streamSeq: String(boundary),
            streamGeneration: generation,
            streamMode: bootstrap ? "direct" : "catchup",
          })
          .where(owned),
      );
      row = (await loadOrigin(database, originId))!;
    }
    if (bootstrap) {
      const boundary = sequence(row.atproto.streamSeq!);
      const client = options.client ?? createPublicationClient();
      const currentPlan = await planFor(row, settings);
      await scanAtmosphere(database, row, client, {
        guard: owned,
        signal: combined,
        publication: async (publication) => {
          await runDatabaseWrite(database, () =>
            database
              .update(feedOriginAtproto)
              .set({
                publicationRecord: publication,
                publicationDirty: true,
                publicationSeq: String(boundary),
              })
              .where(
                and(
                  owned,
                  or(
                    isNull(feedOriginAtproto.publicationSeq),
                    sql`cast(${feedOriginAtproto.publicationSeq} as integer) <= ${boundary}`,
                  ),
                ),
              ),
          );
        },
        records: async (records, rev) => {
          if (combined.aborted) throw combined.reason;
          await runDatabaseWrite(database, () =>
            database.transaction(
              async (tx) => {
                const latest = await loadOrigin(tx, originId);
                if (
                  !latest ||
                  latest.atproto.workOwner !== owner ||
                  combined.aborted ||
                  !eligible(latest, currentPlan, settings, options.manual)
                )
                  throw new Error("Feed no longer eligible");
                await stageDocuments(
                  tx,
                  records.map((record) => ({
                    originId,
                    uri: record.uri,
                    cid: record.cid,
                    record: captureRecordValue(record.value),
                    rev,
                    seq: boundary,
                    now: nowFor(settings),
                  })),
                );
              },
              { behavior: "immediate" },
            ),
          );
        },
      });
      row = (await loadOrigin(database, originId))!;
      if (!row.atproto.initialized || row.atproto.cursor) return;
    }
    if (row.atproto.streamMode !== "live" || options.manual) {
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({ streamMode: "catchup" })
          .where(owned),
      );
      state = await ensureStream(database, settings.service);
      const through = Math.max(
        sequence(row.atproto.streamSeq!),
        bootstrap || options.manual
          ? await currentBoundary(state, transport, settings, combined)
          : sequence(state.seq!),
      );
      {
        for await (const batch of transport.recover(
          sequence(row.atproto.streamSeq!),
          through,
          combined,
          row.atproto.publicationDid,
        )) {
          combined.throwIfAborted();
          await acceptBatch(database, batch, settings, {
            originId,
            manual: options.manual,
          });
          await runDatabaseWrite(database, () =>
            database
              .update(feedOriginAtproto)
              .set({ streamSeq: String(batch.lastCursor) })
              .where(and(owned, eq(feedOriginAtproto.streamMode, "catchup"))),
          );
          if (combined.aborted) throw combined.reason;
        }
      }
      if (combined.aborted) throw combined.reason;
      // Only complete, durably staged intervals can join live application.
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({ streamSeq: String(through), streamMode: "live" })
          .where(and(owned, eq(feedOriginAtproto.streamMode, "catchup"))),
      );
    }
    combined.throwIfAborted();
    await processOriginDocuments(database, originId, settings, processing);
    await runDatabaseWrite(database, () =>
      database
        .update(feedOriginAtproto)
        .set({ recoveryRetryAt: null, recoveryAttempts: 0 })
        .where(owned),
    );
  } catch (error) {
    if (!signal.aborted)
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({
            ...(!transport.hasReplay && streamFailure(error)?.status === 400
              ? { streamMode: "paused" as const, cursor: null }
              : {}),
            recoveryAttempts: candidate.atproto.recoveryAttempts + 1,
            recoveryRetryAt: new Date(
              nowFor(settings).getTime() +
                (streamFailure(error)?.retryAfterMs ??
                  Math.min(
                    3_600_000,
                    5000 *
                      2 ** Math.min(candidate.atproto.recoveryAttempts, 10),
                  )),
            ),
          })
          .where(owned),
      );
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    controller.abort();
    await runDatabaseWrite(database, () =>
      database
        .update(feedOriginAtproto)
        .set({ workOwner: null, workUntil: null })
        .where(owned),
    );
  }
}

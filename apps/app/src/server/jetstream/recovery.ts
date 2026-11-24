import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { feedOriginAtproto } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { scanAtmosphere } from "../rss/scanAtmosphere";
import { createPublicationClient } from "../rss/atprotoClient";
import {
  archiveUnreadable,
  CheckpointHostError,
  sequence,
  streamFailure,
} from "./protocol";
import {
  acceptBatch,
  eligible,
  ensureStream,
  loadOrigin,
  markDocumentsDue,
  nowFor,
  originAppliesLive,
  planFor,
  stageDocuments,
  streamIsConnected,
} from "./store";
import { drainOriginDocuments, pendingDocumentCount } from "./process";
import { captureRecordValue } from "./document-source";
import { forgetOutage, hostUnreachable, recentOutage } from "./reachability";
import type { atprotoStreamState } from "../db/schema";
import type { StreamTransport } from "./transport";
import type { StreamDatabase, StreamOrigin, StreamSettings } from "./store";
import type { ProcessingOptions } from "./process";

/**
 * Where a bootstrap hands over to the stream. A connected worker already
 * applies live events to this origin, so its checkpoint bounds the interval
 * no one covers. The checkpoint is saved on the worker's heartbeat and trails
 * its position, which only widens that interval: it is a lower bound, replayed
 * events apply once, and the scan that follows sees anything the worker passed
 * before the origin could receive it. Otherwise the checkpoint may be frozen,
 * and the transport's tip is the only truthful boundary, at the cost of one
 * connection per read.
 */
async function bootstrapBoundary(
  state: typeof atprotoStreamState.$inferSelect,
  tip: () => Promise<number>,
  settings: StreamSettings,
) {
  return streamIsConnected(state, nowFor(settings))
    ? sequence(state.seq!)
    : tip();
}

/**
 * What a bounded attempt left behind, which decides when the fetch schedule
 * visits the origin next.
 * - `covered`: a connected worker applies the origin's events as they arrive.
 * - `polled`: nothing covers the origin between visits.
 * - `unfinished`: a bounded scan or drain left work for the next visit.
 * - `unreachable`: the stream host gave no answer, so an origin that has its
 *   documents waits for it. The origin did not fail.
 * - `deferred`: an earlier failure's backoff still holds.
 */
export type RecoveryOutcome =
  | { status: "covered" | "polled" | "unfinished" | "unreachable" }
  | { status: "deferred"; retryAt: Date | null };

/** Without a covering worker, staged documents wait for the next visit. */
async function uncoveredOutcome(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
): Promise<RecoveryOutcome> {
  const pending = await pendingDocumentCount(database, originId, settings);
  return { status: pending > 0 ? "unfinished" : "polled" };
}

/** The stream covers an origin it applies live for a user it serves unprompted. */
async function attemptOutcome(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
): Promise<RecoveryOutcome> {
  const [row, state] = await Promise.all([
    loadOrigin(database, originId),
    ensureStream(database, settings.service),
  ]);
  return row &&
    originAppliesLive(row, state, nowFor(settings)) &&
    eligible(row, await planFor(row, settings), settings)
    ? { status: "covered" }
    : uncoveredOutcome(database, originId, settings);
}

/**
 * A bounded attempt retains scan/replay progress. It never truncates the missed
 * interval.
 */
export async function recoverOrigin(
  database: StreamDatabase,
  originId: number,
  settings: StreamSettings,
  transport: StreamTransport,
  signal: AbortSignal,
  options: ProcessingOptions = {},
): Promise<RecoveryOutcome> {
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
    return { status: "deferred", retryAt: candidate.atproto.recoveryRetryAt };
  if (!candidate) return { status: "polled" };
  const plan = await planFor(candidate, settings);
  if (!eligible(candidate, plan, settings, options.manual))
    return { status: "polled" };
  const initialState = await ensureStream(database, settings.service);
  if (originAppliesLive(candidate, initialState, nowFor(settings))) {
    await drainOriginDocuments(database, originId, settings, {
      ...options,
      signal,
    });
    return eligible(candidate, plan, settings)
      ? { status: "covered" }
      : uncoveredOutcome(database, originId, settings);
  }
  const now = nowFor(settings);
  // A connected worker is a contact that succeeded, whichever process made it.
  if (streamIsConnected(initialState, now)) forgetOutage(settings.service);
  // A contact moments ago found the host unreachable. The origin waits
  // without a claim or another connection.
  else if (
    candidate.atproto.initialized &&
    recentOutage(settings.service, now.getTime())
  )
    return { status: "unreachable" };
  const owner = randomUUID();
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
  // Another attempt holds the origin; the next visit sees what it left.
  if (!claimed.length) return { status: "unfinished" };
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
  // Whether the stream host answered during this attempt.
  let reachedHost = false;
  const tip = async () => {
    const position = await transport.tip(combined);
    reachedHost = true;
    return position;
  };
  try {
    combined.throwIfAborted();
    let row = await loadOrigin(database, originId);
    if (
      !row ||
      !eligible(row, await planFor(row, settings), settings, options.manual)
    )
      return { status: "polled" };
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
      // With replay, a new origin's checkpoint is a safe lower bound: the
      // archive fills the rest. An origin that has its documents bootstraps
      // again only after its archive could not be read, and takes the
      // boundary of an instance without replay, past that data.
      const boundary = bootstrap
        ? transport.hasReplay && !row.atproto.initialized
          ? sequence(state.seq)
          : await bootstrapBoundary(state, tip, settings)
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
    /**
     * Stages the repository as it stands, which holds every change up to
     * `boundary`, and returns the origin as the scan left it.
     */
    const scan = async (origin: StreamOrigin, boundary: number) => {
      const client = options.client ?? createPublicationClient();
      const currentPlan = await planFor(origin, settings);
      await scanAtmosphere(database, origin, client, {
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
                const awaitsImport = await stageDocuments(
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
                // Should this attempt end before its drain, the sweep finds
                // the documents once the origin is live.
                if (awaitsImport) await markDocumentsDue(tx, latest);
              },
              { behavior: "immediate" },
            ),
          );
        },
      });
      return (await loadOrigin(database, originId))!;
    };
    /** The bounded scan kept its cursor; the next visit continues it. */
    const scanUnfinished = (origin: StreamOrigin) =>
      !origin.atproto.initialized || Boolean(origin.atproto.cursor);
    if (bootstrap) {
      row = await scan(row, sequence(row.atproto.streamSeq!));
      if (scanUnfinished(row)) return { status: "unfinished" };
    }
    if (row.atproto.streamMode !== "live" || options.manual) {
      const publisher = row.atproto.publicationDid;
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({ streamMode: "catchup" })
          .where(owned),
      );
      state = await ensureStream(database, settings.service);
      // No scan follows the catch-up of an initialized origin. The worker's
      // checkpoint trails its position, so an event the worker passed while
      // the origin could not receive it may lie beyond that checkpoint. Only
      // the transport's tip is past every such event.
      const through = Math.max(
        sequence(row.atproto.streamSeq!),
        bootstrap ? await bootstrapBoundary(state, tip, settings) : await tip(),
      );
      // Publishers of the events this catch-up could not read.
      const unread = new Set<string>();
      {
        for await (const batch of transport.recover(
          sequence(row.atproto.streamSeq!),
          through,
          combined,
          publisher,
          (did) => unread.add(did),
        )) {
          reachedHost = true;
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
      const inMode = (mode: "catchup" | "direct") =>
        and(owned, eq(feedOriginAtproto.streamMode, mode));
      // The stream cannot deliver an event of this origin's publisher that
      // the catch-up could not read; only the repository has what it carried.
      // The origin is marked first, so an attempt that ends during the scan
      // still owes it at the next visit.
      const rescans = unread.has(publisher);
      if (rescans) {
        await runDatabaseWrite(database, () =>
          database
            .update(feedOriginAtproto)
            .set({ streamSeq: String(through), streamMode: "direct" })
            .where(inMode("catchup")),
        );
        row = await scan((await loadOrigin(database, originId))!, through);
        if (scanUnfinished(row)) return { status: "unfinished" };
      }
      // Only complete, durably staged intervals can join live application.
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({ streamSeq: String(through), streamMode: "live" })
          .where(inMode(rescans ? "direct" : "catchup")),
      );
    }
    combined.throwIfAborted();
    await drainOriginDocuments(database, originId, settings, processing);
    await runDatabaseWrite(database, () =>
      database
        .update(feedOriginAtproto)
        .set({ recoveryRetryAt: null, recoveryAttempts: 0 })
        .where(owned),
    );
    return await attemptOutcome(database, originId, settings);
  } catch (error) {
    // The host never answered this attempt. An origin that has its documents
    // waits for it: nothing about the origin failed, so nothing is recorded.
    if (
      candidate.atproto.initialized &&
      !reachedHost &&
      hostUnreachable(error)
    ) {
      transport.report(error, "feed-recovery");
      return { status: "unreachable" };
    }
    if (!signal.aborted)
      await runDatabaseWrite(database, () =>
        database
          .update(feedOriginAtproto)
          .set({
            ...(!transport.hasReplay && streamFailure(error)?.status === 400
              ? { streamMode: "paused" as const, cursor: null }
              : {}),
            // Archive data that could not be decoded after an attempt that
            // failed too will not decode on another read. The origin gives
            // that stretch up: its next visit takes a new boundary and scans
            // the repository.
            ...(archiveUnreadable(error) &&
            candidate.atproto.recoveryAttempts > 0
              ? { streamMode: "direct" as const, streamSeq: null }
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

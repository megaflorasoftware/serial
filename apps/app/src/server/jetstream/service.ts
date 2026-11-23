import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, isNull } from "drizzle-orm";
import { atprotoStreamState, feedOriginAtproto } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { publisher } from "../api/publisher";
import { getUserChannel } from "../api/channels";
import {
  acceptBatch,
  claimStream,
  connectStream,
  declareStreamGap,
  disconnectStream,
  distrustOriginCoverage,
  ensureStream,
  holdStream,
  saveCheckpoint,
} from "./store";
import { recoverOrigin } from "./recovery";
import { RecoveryDeferredError } from "./deferred";
import { drainDueOrigins, processOriginDocuments } from "./process";
import { sweepReferenceSnapshots } from "./reference-snapshots";
import { createStreamTransport, retryStream } from "./transport";
import { normalizeService, sequence, StreamFailure } from "./protocol";
import { createStreamReporter } from "./report";
import { resolveStreamService } from "./endpoint";
import { startStreamIntake } from "./intake";
import { hostUnreachable } from "./reachability";
import type { RecoveryOutcome } from "./recovery";
import type { FetchableOrigin } from "../rss/types";
import type { FeedResult } from "../rss/fetchFeeds";
import type { CommittedUpdate } from "./process";
import type { StreamIntake } from "./intake";
import type { StreamEvent } from "./protocol";
import type { StreamDatabase, StreamSettings } from "./store";
import { ALL_CONTENT_STATUS_KEYS } from "~/lib/reconciliation/invalidation";
import { isLegacyJetstream } from "~/lib/jetstream-endpoint";
import { env } from "~/env";
import { workerPool } from "~/lib/workerPool";

const SNAPSHOT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 30_000;
/**
 * The legacy wire replays from a time cursor and silently omits what it has
 * pruned, 24 hours back by default. A checkpoint this recent is well inside
 * that window; an older one cannot be vouched for.
 */
const LEGACY_RESUME_TRUST_MS = 60 * 60 * 1000;

/** A legacy checkpoint is a time in microseconds; a stale one may resume past pruned events. */
export function legacyResumeLeavesGap(
  service: string,
  checkpoint: number,
  now: number,
) {
  return (
    isLegacyJetstream(service) &&
    now - checkpoint / 1000 > LEGACY_RESUME_TRUST_MS
  );
}

async function configuration() {
  const settings: StreamSettings = {
    service: await resolveStreamService(env.ATPROTO_JETSTREAM_ENDPOINT),
    backgroundEnabled: env.BACKGROUND_REFRESH_ENABLED,
  };
  return {
    settings,
    transport: createStreamTransport({
      service: settings.service,
      apiKey: env.ATPROTO_JETSTREAM_API_KEY,
    }),
  };
}

export async function publishStreamUpdate(update: CommittedUpdate) {
  await publisher.publish(getUserChannel(update.userId), {
    source: "rss",
    chunk: {
      type: "feed-items",
      feedId: update.feedId,
      feedItems: update.items,
      removedItemIds: update.removedItemIds,
    },
    invalidation: {
      type: "reconciliation-invalidation",
      domains: update.metadataChanged
        ? ["organization", "navigation"]
        : ["navigation"],
      scopeImpact: {
        type: "known",
        selectors: [
          {
            type: "feed-memberships",
            feedIds: [update.feedId],
            contentStatusKeys: ALL_CONTENT_STATUS_KEYS,
          },
        ],
      },
    },
  });
}

async function establishBoundary(
  database: StreamDatabase,
  config: Awaited<ReturnType<typeof configuration>>,
  signal: AbortSignal,
) {
  const state = await ensureStream(database, config.settings.service);
  if (state.seq !== null) return;
  const controller = new AbortController();
  try {
    for await (const batch of config.transport.stream(
      undefined,
      AbortSignal.any([signal, controller.signal]),
    )) {
      await runDatabaseWrite(database, () =>
        database
          .update(atprotoStreamState)
          .set({ seq: String(batch.lastCursor) })
          .where(
            and(
              eq(atprotoStreamState.id, "primary"),
              isNull(atprotoStreamState.seq),
            ),
          ),
      );
      return;
    }
  } finally {
    controller.abort();
  }
}

export { originStillAppliesLive } from "./store";

/** A failed recovery left its backoff on the origin; an earlier failure left none. */
async function recoveryRetryAt(database: StreamDatabase, originId: number) {
  const row = await database
    .select({ retryAt: feedOriginAtproto.recoveryRetryAt })
    .from(feedOriginAtproto)
    .where(eq(feedOriginAtproto.originId, originId))
    .get();
  return row?.retryAt ?? null;
}

export type StreamRefresh = { result: FeedResult; outcome: RecoveryOutcome };

/**
 * Called by existing import/refresh entry points; the saved Feed survives
 * failure. A failure stays an error until a later recovery succeeds. An
 * origin that has its documents and cannot reach the stream host did not
 * fail: its fetch is skipped and shows nothing. The outcome tells the caller
 * when the fetch schedule should visit the origin next, so the recovery
 * backoff, an outage and the stream's coverage share that one clock.
 */
export async function refreshStreamOrigin(
  database: StreamDatabase,
  fetchable: FetchableOrigin,
  options: { drain?: boolean } = {},
): Promise<StreamRefresh> {
  const config = await configuration();
  const signal = AbortSignal.timeout(50_000);
  const updates: CommittedUpdate[] = [];
  const ids = { id: fetchable.feed.id, originId: fetchable.origin.id };
  /** Nothing about the origin failed, so its fetch shows nothing. */
  const waiting: StreamRefresh = {
    result: { status: "skipped", ...ids },
    outcome: { status: "unreachable" },
  };
  /** The fetch failed, and the schedule follows whatever backoff recovery stored. */
  const failed = async (error: unknown): Promise<StreamRefresh> => {
    config.transport.report(error, "feed-recovery");
    return {
      result: { status: "error", ...ids, error },
      outcome: {
        status: "deferred",
        retryAt: await recoveryRetryAt(database, fetchable.origin.id),
      },
    };
  };
  try {
    await establishBoundary(database, config, signal);
  } catch (error) {
    // Recovery has not begun, so it had no say. An origin that has its
    // documents waits when the host gave no answer for the stream's boundary.
    if (!(fetchable.origin.atproto?.initialized && hostUnreachable(error)))
      return failed(error);
    config.transport.report(error, "feed-recovery");
    return waiting;
  }
  let outcome: RecoveryOutcome;
  try {
    outcome = await recoverOrigin(
      database,
      fetchable.origin.id,
      config.settings,
      config.transport,
      signal,
      {
        // The ordinary fetch path already owns eligibility.
        manual: true,
        drain: options.drain,
        publish: async (update) => {
          updates.push(update);
        },
      },
    );
  } catch (error) {
    // Recovery decides which failures wait and returns those. Anything it
    // throws is an error, and the schedule follows whatever backoff is stored.
    return failed(error);
  }
  if (outcome.status === "unreachable") return waiting;
  if (outcome.status === "deferred")
    return {
      result: { status: "error", ...ids, error: new RecoveryDeferredError() },
      outcome,
    };
  return {
    result: {
      status: updates.length ? "success" : "empty",
      ...ids,
      feedItems: updates.flatMap((update) => update.items),
      removedItemIds: updates.flatMap((update) => update.removedItemIds),
      metadataChanged: updates.some((update) => update.metadataChanged),
    },
    outcome,
  };
}

/** Whether any Feed here follows the Atmosphere. */
async function followsAtmosphere(database: StreamDatabase) {
  const tracked = await database
    .select({ id: feedOriginAtproto.originId })
    .from(feedOriginAtproto)
    .limit(1);
  return tracked.length > 0;
}

export async function startStreamWorker(
  database: StreamDatabase,
  shutdown: AbortSignal,
) {
  if (!env.BACKGROUND_REFRESH_ENABLED) return;
  let configured: Awaited<ReturnType<typeof configuration>> | undefined;
  let retries = 0;
  while (!shutdown.aborted && !configured) {
    try {
      // An instance that follows nothing on the Atmosphere never contacts the
      // stream host, and holds no lease.
      if (!(await followsAtmosphere(database))) {
        await delay(10_000, undefined, { signal: shutdown }).catch(() => {});
        continue;
      }
      configured = await configuration();
    } catch (error) {
      createStreamReporter(
        normalizeService(env.ATPROTO_JETSTREAM_ENDPOINT),
        shutdown,
      )(error, "configuration");
      await retryStream(error, retries++, shutdown).catch(() => {});
    }
  }
  if (!configured) return;
  const config = configured;
  const owner = randomUUID();
  const service = config.settings.service;
  // Only the instance consuming the stream drains its retries.
  const lease = { held: false };

  async function processOrigins(originIds: number[]) {
    for await (const unused of workerPool(originIds, 4, async (originId) => {
      try {
        await processOriginDocuments(database, originId, config.settings, {
          publish: publishStreamUpdate,
        });
      } catch (error) {
        config.transport.report(error, "document-processing");
      }
    })) {
      void unused;
    }
  }
  const openIntake = () =>
    startStreamIntake({
      database,
      apply: (events: StreamEvent[]) =>
        acceptBatch(database, { events }, config.settings, {
          onOrigins: processOrigins,
        }),
      distrust: (originIds) =>
        distrustOriginCoverage(database, originIds, new Date()),
    });
  /** A closing connection leaves the newest position a restart may resume from. */
  async function saveProgress(intake: StreamIntake) {
    try {
      // A failed refresh keeps the earlier checkpoint, which is still safe.
      await intake
        .refresh()
        .catch((error: unknown) => config.transport.report(error, "intake"));
      const checkpoint = intake.checkpoint();
      if (checkpoint !== undefined)
        await saveCheckpoint(database, owner, checkpoint);
    } catch (error) {
      config.transport.report(error, "checkpoint");
    }
  }
  /** A stale legacy cursor is a rejected one: resume at the tip and recover every origin. */
  async function trustedBoundary(signal: AbortSignal) {
    const stored = await ensureStream(database, service);
    if (
      stored.seq !== null &&
      legacyResumeLeavesGap(service, sequence(stored.seq), Date.now())
    )
      await declareStreamGap(database, owner, new Date());
    await establishBoundary(database, config, signal);
    return ensureStream(database, service);
  }

  /** A write the loop outlives: its failure is reported and the next connection redoes it. */
  async function settle(operation: string, write: () => Promise<unknown>) {
    try {
      await write();
    } catch (error) {
      config.transport.report(error, operation);
    }
  }

  async function consume() {
    let attempt = 0;
    while (!shutdown.aborted) {
      const connection = new AbortController();
      const signal = AbortSignal.any([shutdown, connection.signal]);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let intake: StreamIntake | undefined;
      try {
        lease.held = await claimStream(database, service, owner, new Date());
        if (!lease.held) {
          await delay(10_000, undefined, { signal });
          continue;
        }
        heartbeat = setInterval(() => {
          void holdStream(database, owner, new Date(), intake?.checkpoint())
            .then((held) => {
              lease.held = held;
              if (!held) connection.abort();
            })
            .catch((error: unknown) => {
              config.transport.report(error, "lease");
              connection.abort();
            });
          // A failed refresh may have lost replayed events. Reconnecting
          // resumes from the checkpoint saved before them.
          intake?.refresh().catch((error: unknown) => {
            config.transport.report(error, "intake");
            connection.abort();
          });
        }, HEARTBEAT_INTERVAL_MS);
        if (!(await followsAtmosphere(database))) {
          await delay(10_000, undefined, { signal });
          continue;
        }
        const state = await trustedBoundary(signal);
        // The followed set loads once a connection opens, before its first
        // event, so attempts that never connect read nothing.
        let opening: Promise<StreamIntake> | undefined;
        const openedIntake = async () => {
          intake = await (opening ??= openIntake());
          return intake;
        };
        try {
          // Keep collection filters stable as readers follow new Publications. A DID-filter
          // refresh could skip the new repository while the global cursor advances.
          for await (const batch of config.transport.stream(
            sequence(state.seq!),
            signal,
            undefined,
            async () => {
              signal.throwIfAborted();
              if (
                !(await connectStream(
                  database,
                  owner,
                  state.generation,
                  new Date(),
                ))
              )
                throw new StreamFailure("connection-ownership");
              await openedIntake();
            },
          )) {
            await (await openedIntake()).accept(batch);
            // A delivered batch starts the reconnect backoff over.
            attempt = 0;
          }
        } finally {
          const closing = intake;
          intake = undefined;
          if (closing) await saveProgress(closing);
        }
        if (!signal.aborted) throw new StreamFailure("connection-closed");
      } catch (error) {
        if (signal.aborted) continue;
        config.transport.report(error, "consumer");
        if (error instanceof StreamFailure && error.status === 400)
          // The rejected cursor left a gap that only each origin's refresh fills.
          await settle("gap", () =>
            declareStreamGap(database, owner, new Date()),
          );
        // Any other outage leaves the origins alone. The next connection
        // replays from the checkpoint, and polling could not reach this host
        // either.
        await retryStream(error, attempt++, shutdown).catch(() => {});
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        connection.abort();
        // A release that fails is made again when the next connection ends.
        await settle("lease", () => disconnectStream(database, owner));
      }
    }
  }
  async function sweep() {
    let lastSnapshotSweep = 0;
    while (!shutdown.aborted) {
      try {
        // Reference snapshots nobody has read for the retention window go once a day.
        if (
          lease.held &&
          Date.now() - lastSnapshotSweep >= SNAPSHOT_SWEEP_INTERVAL_MS
        ) {
          lastSnapshotSweep = Date.now();
          await sweepReferenceSnapshots(database, new Date());
        }
        // Only drain staged work. Repository/archive recovery belongs to normal fetches.
        await drainDueOrigins(database, config.settings, {
          holdsLease: () => lease.held,
          signal: shutdown,
          publish: publishStreamUpdate,
          report: (error) => config.transport.report(error, "document-retry"),
        });
      } catch (error) {
        if (!shutdown.aborted) config.transport.report(error, "document-retry");
      }
      await delay(SWEEP_INTERVAL_MS, undefined, { signal: shutdown }).catch(
        () => {},
      );
    }
  }
  return Promise.all([consume(), sweep()]).then(() => undefined);
}

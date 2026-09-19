import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { atprotoStreamState, feedOriginAtproto } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import { publisher } from "../api/publisher";
import { getUserChannel } from "../api/channels";
import {
  acceptBatch,
  claimStream,
  ensureStream,
  interruptStream,
  ORIGIN_PAGE_SIZE,
} from "./store";
import { recoverOrigin } from "./recovery";
import { processOriginDocuments } from "./process";
import { sweepReferenceSnapshots } from "./reference-snapshots";

const SNAPSHOT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
import { createStreamTransport, retryStream } from "./transport";
import { normalizeService, sequence, StreamFailure } from "./protocol";
import { createStreamReporter } from "./report";
import { resolveStreamService } from "./endpoint";
import type { FetchableOrigin } from "../rss/types";
import type { CommittedUpdate } from "./process";
import type { StreamDatabase, StreamSettings } from "./store";
import { ALL_CONTENT_STATUS_KEYS } from "~/lib/reconciliation/invalidation";
import { env } from "~/env";
import { workerPool } from "~/lib/workerPool";

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

/** Called by existing import/refresh entry points; the saved Feed survives failure. */
export async function refreshStreamOrigin(
  database: StreamDatabase,
  fetchable: FetchableOrigin,
) {
  const config = await configuration();
  const signal = AbortSignal.timeout(50_000);
  const updates: CommittedUpdate[] = [];
  try {
    await establishBoundary(database, config, signal);
    await recoverOrigin(
      database,
      fetchable.origin.id,
      config.settings,
      config.transport,
      signal,
      {
        // The ordinary fetch path already owns scheduling and eligibility.
        manual: true,
        publish: async (update) => {
          updates.push(update);
        },
      },
    );
  } catch (error) {
    config.transport.report(error, "feed-recovery");
    throw error;
  }
  return {
    status: updates.length ? ("success" as const) : ("empty" as const),
    id: fetchable.feed.id,
    originId: fetchable.origin.id,
    feedItems: updates.flatMap((update) => update.items),
    removedItemIds: updates.flatMap((update) => update.removedItemIds),
    metadataChanged: updates.some((update) => update.metadataChanged),
  };
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
  async function consume() {
    let attempt = 0;
    while (!shutdown.aborted) {
      const connection = new AbortController();
      const signal = AbortSignal.any([shutdown, connection.signal]);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        if (
          !(await claimStream(
            database,
            config.settings.service,
            owner,
            new Date(),
          ))
        ) {
          await delay(10_000, undefined, { signal });
          continue;
        }
        heartbeat = setInterval(() => {
          void claimStream(database, config.settings.service, owner, new Date())
            .then((claimed) => {
              if (!claimed) connection.abort();
            })
            .catch((error: unknown) => {
              config.transport.report(error, "lease");
              connection.abort();
            });
        }, 15_000);
        const tracked = await database
          .select({ id: feedOriginAtproto.originId })
          .from(feedOriginAtproto)
          .limit(1);
        if (!tracked.length) {
          await delay(10_000, undefined, { signal });
          continue;
        }
        const [connectionState] = await interruptStream(database, owner, true);
        if (!connectionState) throw new StreamFailure("connection-ownership");
        await establishBoundary(database, config, signal);
        const state = await ensureStream(database, config.settings.service);
        // Keep collection filters stable as readers follow new Publications. A DID-filter
        // refresh could skip the new repository while the global cursor advances.
        for await (const batch of config.transport.stream(
          sequence(state.seq!),
          signal,
          undefined,
          async () => {
            signal.throwIfAborted();
            const rows = await runDatabaseWrite(database, () =>
              database
                .update(atprotoStreamState)
                .set({ connected: true })
                .where(
                  and(
                    eq(atprotoStreamState.id, "primary"),
                    eq(atprotoStreamState.leaseOwner, owner),
                    eq(
                      atprotoStreamState.generation,
                      connectionState.generation,
                    ),
                    gt(atprotoStreamState.leaseUntil, new Date()),
                  ),
                )
                .returning({ id: atprotoStreamState.id }),
            );
            if (!rows.length) throw new StreamFailure("connection-ownership");
          },
        )) {
          await acceptBatch(database, batch, config.settings, {
            owner,
            onOrigins: async (originIds) => {
              for await (const unused of workerPool(
                originIds,
                4,
                async (originId) => {
                  try {
                    await processOriginDocuments(
                      database,
                      originId,
                      config.settings,
                      { publish: publishStreamUpdate },
                    );
                  } catch (error) {
                    config.transport.report(error, "document-processing");
                  }
                },
              )) {
                void unused;
              }
            },
          });
          attempt = 0;
        }
        if (!signal.aborted) throw new StreamFailure("connection-closed");
      } catch (error) {
        if (signal.aborted) continue;
        config.transport.report(error, "consumer");
        if (error instanceof StreamFailure && error.status === 400) {
          // Resume the live tip; each Feed retains its own recovery position.
          await runDatabaseWrite(database, () =>
            database
              .update(atprotoStreamState)
              .set({ seq: null })
              .where(
                and(
                  eq(atprotoStreamState.id, "primary"),
                  eq(atprotoStreamState.leaseOwner, owner),
                ),
              ),
          );
        }
        await interruptStream(database, owner);
        await retryStream(error, attempt++, shutdown).catch(() => {});
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        connection.abort();
        await interruptStream(database, owner);
      }
    }
  }
  async function sweep() {
    let lastSnapshotSweep = 0;
    while (!shutdown.aborted) {
      let after = 0;
      try {
        // Reference snapshots nobody has read for the retention window go once a day.
        if (Date.now() - lastSnapshotSweep >= SNAPSHOT_SWEEP_INTERVAL_MS) {
          lastSnapshotSweep = Date.now();
          await sweepReferenceSnapshots(database, new Date());
        }
        while (!shutdown.aborted) {
          const rows = await database
            .select({ id: feedOriginAtproto.originId })
            .from(feedOriginAtproto)
            .where(gt(feedOriginAtproto.originId, after))
            .orderBy(asc(feedOriginAtproto.originId))
            .limit(ORIGIN_PAGE_SIZE);
          if (!rows.length) break;
          for await (const unused of workerPool(rows, 4, async (row) => {
            try {
              // Only drain staged work. Repository/archive recovery belongs to normal fetches.
              await processOriginDocuments(database, row.id, config.settings, {
                signal: shutdown,
                publish: publishStreamUpdate,
              });
            } catch (error) {
              if (!shutdown.aborted)
                config.transport.report(error, "document-retry");
            }
          })) {
            void unused;
          }
          after = rows.at(-1)!.id;
        }
      } catch (error) {
        if (!shutdown.aborted) config.transport.report(error, "document-retry");
      }
      await delay(30_000, undefined, { signal: shutdown }).catch(() => {});
    }
  }
  return Promise.all([consume(), sweep()]).then(() => undefined);
}

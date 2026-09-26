import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { parsePublicationUri } from "@serial/standard-site";
import {
  assertSubscriptionSyncCurrent,
  renewSubscriptionSync,
  syncClaimCondition,
} from "./state";
import type { db } from "~/server/db";
import type { DatabaseAtprotoConnection } from "~/server/db/schema";
import type { OriginEvidence } from "~/server/feeds/revalidationEvidence";
import { PublicationUnavailableError } from "~/server/feeds/publications";
import {
  atprotoConnections,
  feedOrigins,
  feeds,
  publicationBackfillProbes as probes,
} from "~/server/db/schema";
import {
  attachMissingFeedOrigins,
  findFeedForOrigins,
  withOrigins,
} from "~/server/feeds/origins";
import {
  originsShareArticles,
  readOriginEvidence,
} from "~/server/feeds/revalidationEvidence";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { applyOriginMetadata } from "~/server/rss/originMetadata";
import { workerPool } from "~/lib/workerPool";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { hasAtprotoWriteScope } from "~/server/auth/atproto/config";
import { logError } from "~/server/logger";
import { TEXT_PLATFORMS } from "~/lib/content/descriptor";

export const BACKFILL_BATCH_SIZE = 8;
export const BACKFILL_CONCURRENCY = 2;

/** An absent declaration is final; transport and server failures remain retryable. */
export async function readBackfillPublication(
  siteUrl: string,
): Promise<OriginEvidence | null> {
  const response = await readFeedHttp(
    new URL("/.well-known/site.standard.publication", siteUrl).href,
    {
      maxBodyBytes: 4096,
      totalDurationMs: 5_000,
    },
  );
  if (
    response.status >= 400 &&
    response.status < 500 &&
    ![408, 425, 429].includes(response.status)
  )
    return null;
  if (!response.ok) throw new Error("Publication discovery unavailable");
  const uri = response.text.trim();
  if (!parsePublicationUri(uri)) return null;
  return readOriginEvidence({ kind: "atproto", locator: uri });
}

export async function backfillPublicationOrigins(
  database: typeof db,
  connection: DatabaseAtprotoConnection,
  dependencies = { readOriginEvidence, readBackfillPublication },
): Promise<{ attached: number; retryAt?: Date }> {
  const userId = connection.userId!;
  if (
    !connection.exportSubscriptions ||
    !hasAtprotoWriteScope(connection.scopes)
  )
    return { attached: 0 };
  if (connection.subscriptionBackfillStarted) {
    const next = connection.subscriptionBackfillNextAttemptAt;
    if (!next || next.getTime() > Date.now())
      return { attached: 0, ...(next ? { retryAt: next } : {}) };
  }
  await assertSubscriptionSyncCurrent(database, connection, true);
  if (!connection.subscriptionBackfillStarted) {
    await runDatabaseWrite(database, () =>
      database.transaction(
        async (tx) => {
          await assertSubscriptionSyncCurrent(tx, connection, true);
          // Snapshot existing Feeds once. Later Feed creation already performs discovery.
          await tx
            .insert(probes)
            .select(
              tx
                .select({
                  feedId: feeds.id,
                  userId: feeds.userId,
                  attempts: sql<number>`0`.as("attempts"),
                  nextAttemptAt: sql<number>`${Date.now()}`.as(
                    "next_attempt_at",
                  ),
                })
                .from(feeds)
                .where(
                  and(
                    eq(feeds.userId, userId),
                    inArray(feeds.platform, TEXT_PLATFORMS),
                    notExists(
                      tx
                        .select({ id: feedOrigins.id })
                        .from(feedOrigins)
                        .where(
                          and(
                            eq(feedOrigins.feedId, feeds.id),
                            eq(feedOrigins.kind, "atproto"),
                          ),
                        ),
                    ),
                  ),
                ),
            )
            .onConflictDoNothing();
          await tx
            .update(atprotoConnections)
            .set({
              subscriptionBackfillStarted: true,
              subscriptionBackfillNextAttemptAt: new Date(),
            })
            .where(eq(atprotoConnections.id, connection.id));
        },
        { behavior: "immediate" },
      ),
    );
  }
  const due = await database
    .select()
    .from(probes)
    .where(
      and(eq(probes.userId, userId), lte(probes.nextAttemptAt, new Date())),
    )
    .orderBy(asc(probes.nextAttemptAt), asc(probes.feedId))
    .limit(BACKFILL_BATCH_SIZE);
  let attached = 0;
  for await (const result of workerPool(
    due,
    BACKFILL_CONCURRENCY,
    async (probe) => {
      try {
        await runDatabaseWrite(database, () =>
          renewSubscriptionSync(database, connection),
        );
        await assertSubscriptionSyncCurrent(database, connection, true);
        const rows = await database
          .select()
          .from(feeds)
          .where(and(eq(feeds.id, probe.feedId), eq(feeds.userId, userId)));
        const [feed] = await withOrigins(database, rows);
        const rss = feed?.origins.find((origin) => origin.kind === "rss");
        let candidate: OriginEvidence | null = null;
        if (
          feed &&
          rss &&
          !feed.origins.some((origin) => origin.kind === "atproto")
        ) {
          const evidence = await dependencies.readOriginEvidence(rss);
          const siteUrl = evidence.siteUrl ?? feed.siteUrl;
          if (siteUrl && evidence.itemUrls.size) {
            candidate = await dependencies.readBackfillPublication(siteUrl);
            if (candidate && !originsShareArticles(evidence, candidate))
              candidate = null;
          }
        }
        return await runDatabaseWrite(database, () =>
          database.transaction(
            async (tx) => {
              await assertSubscriptionSyncCurrent(tx, connection, true);
              let added = 0;
              if (candidate && feed && rss) {
                const currentRows = await tx
                  .select()
                  .from(feeds)
                  .where(and(eq(feeds.id, feed.id), eq(feeds.userId, userId)));
                const [current] = await withOrigins(tx, currentRows);
                if (
                  current &&
                  !current.origins.some((origin) => origin.kind === "atproto")
                ) {
                  if (
                    !current.origins.some(
                      (origin) =>
                        origin.kind === "rss" && origin.locator === rss.locator,
                    )
                  )
                    throw new Error("Feed changed during backfill");
                  const match = await findFeedForOrigins(tx, userId, [
                    candidate.origin,
                  ]);
                  // A conflict is a completed check; automatic backfill never merges Feeds.
                  if (!match || match.id === current.id) {
                    const enriched = await attachMissingFeedOrigins(
                      tx,
                      current,
                      [candidate.origin],
                    );
                    const origin = enriched.origins.find(
                      (entry) => entry.kind === "atproto",
                    )!;
                    await applyOriginMetadata(
                      tx,
                      { feed: enriched, origin },
                      {
                        name: candidate.origin.sourceName ?? "",
                        imageUrl: candidate.origin.sourceImageUrl,
                        description: candidate.origin.sourceDescription,
                        siteUrl: candidate.siteUrl,
                      },
                    );
                    added = 1;
                  }
                }
              }
              await tx
                .update(probes)
                .set({ nextAttemptAt: null })
                .where(eq(probes.feedId, probe.feedId));
              return added;
            },
            { behavior: "immediate" },
          ),
        );
      } catch (error) {
        logError(
          "[publication-sync] backfill probe failed",
          probe.feedId,
          error,
        );
        await runDatabaseWrite(database, () =>
          database
            .update(probes)
            .set({
              attempts: probe.attempts + 1,
              nextAttemptAt:
                error instanceof PublicationUnavailableError
                  ? null
                  : new Date(
                      Date.now() +
                        Math.min(
                          3_600_000,
                          60_000 * 2 ** Math.min(probe.attempts, 6),
                        ),
                    ),
            })
            .where(eq(probes.feedId, probe.feedId)),
        );
        return 0;
      }
    },
  ))
    attached += result;
  const pending = await database
    .select({ next: probes.nextAttemptAt })
    .from(probes)
    .where(and(eq(probes.userId, userId), isNotNull(probes.nextAttemptAt)))
    .orderBy(asc(probes.nextAttemptAt))
    .limit(1)
    .get();
  await database
    .update(atprotoConnections)
    .set({ subscriptionBackfillNextAttemptAt: pending?.next ?? null })
    .where(syncClaimCondition(connection));
  return { attached, retryAt: pending?.next ?? undefined };
}

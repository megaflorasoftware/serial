import { parsePublicationUri } from "@serial/standard-site";
import type { db } from "~/server/db";
import type { OriginEvidence } from "~/server/feeds/revalidationEvidence";
import {
  attachMissingFeedOrigins,
  findFeedForOrigins,
  loadUserFeedWithOrigins,
} from "~/server/feeds/origins";
import {
  originsShareArticles,
  readOriginEvidence,
} from "~/server/feeds/revalidationEvidence";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { applyOriginMetadata } from "~/server/rss/originMetadata";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { requestSyncForFeedChange } from "~/server/publication-sync/requests";
import { wakeRequestedSync } from "~/server/publication-sync/wake";
import { withDiscoveryPacing } from "~/server/http/pacing";

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

/**
 * Publication backfill for one RSS-only Feed: the site's declared publication
 * joins the Feed when its articles overlap the RSS feed's. Resolves to whether
 * it joined. A missing declaration, no overlap, or a publication another Feed
 * already holds is a finished check. A failure that may pass later throws.
 * Its reads are discovery-side work.
 */
export async function backfillPublicationOrigin(
  database: typeof db,
  userId: string,
  feedId: number,
  dependencies = { readOriginEvidence, readBackfillPublication },
): Promise<boolean> {
  const feed = await loadUserFeedWithOrigins(database, userId, feedId);
  const rss = feed?.origins.find((origin) => origin.kind === "rss");
  if (!feed || !rss || feed.origins.some((origin) => origin.kind === "atproto"))
    return false;
  const candidate = await withDiscoveryPacing(async () => {
    const evidence = await dependencies.readOriginEvidence(rss);
    const siteUrl = evidence.siteUrl ?? feed.siteUrl;
    if (!siteUrl || !evidence.itemUrls.size) return null;
    const declared = await dependencies.readBackfillPublication(siteUrl);
    return declared && originsShareArticles(evidence, declared)
      ? declared
      : null;
  });
  if (!candidate) return false;
  const attached = await runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
        const current = await loadUserFeedWithOrigins(tx, userId, feedId);
        if (
          !current ||
          current.origins.some((origin) => origin.kind === "atproto")
        )
          return null;
        if (
          !current.origins.some(
            (origin) => origin.kind === "rss" && origin.locator === rss.locator,
          )
        )
          throw new Error("Feed changed during backfill");
        const match = await findFeedForOrigins(tx, userId, [candidate.origin]);
        // A conflict is a finished check; automatic backfill never merges Feeds.
        if (match && match.id !== current.id) return null;
        const enriched = await attachMissingFeedOrigins(tx, current, [
          candidate.origin,
        ]);
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
        // The publication is a new subscription for sync to export.
        return {
          syncRequested: await requestSyncForFeedChange(tx, userId, [
            current.id,
          ]),
        };
      },
      { behavior: "immediate" },
    ),
  );
  wakeRequestedSync(database, attached?.syncRequested ?? false);
  return attached !== null;
}

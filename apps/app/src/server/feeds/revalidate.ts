import { discoverFeedOriginsForRevalidation } from "./discovery";
import {
  attachMissingFeedOrigins,
  FEED_ORIGIN_CONFLICT,
  findFeedForOrigins,
  loadUserFeedWithOrigins,
} from "./origins";
import {
  originsShareArticles,
  readOriginEvidence,
  REVALIDATION_MAX_CANDIDATES,
} from "./revalidationEvidence";
import type { FeedDatabase } from "./origins";
import type { OriginEvidence } from "./revalidationEvidence";
import type { db } from "~/server/db";
import { feedsSchema } from "~/server/db/schema";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { applyOriginMetadata } from "~/server/rss/originMetadata";
import { requestSyncForFeedChange } from "~/server/publication-sync/requests";
import { wakeRequestedSync } from "~/server/publication-sync/wake";
import { withDiscoveryPacing } from "~/server/http/pacing";

async function ownedFeed(
  database: FeedDatabase,
  userId: string,
  feedId: number,
) {
  const feed = await loadUserFeedWithOrigins(database, userId, feedId);
  if (!feed) throw new Error("Feed not found");
  return feed;
}

type RevalidationDependencies = {
  readOriginEvidence: typeof readOriginEvidence;
  discoverFeedOriginsForRevalidation: typeof discoverFeedOriginsForRevalidation;
};

/**
 * What the Feed's origins say about themselves, and an origin of a missing
 * kind that shares their articles, when discovery finds one.
 */
async function observeOrigins(
  feed: Awaited<ReturnType<typeof ownedFeed>>,
  dependencies: RevalidationDependencies,
) {
  const evidence = await Promise.all(
    feed.origins.map((origin) =>
      dependencies.readOriginEvidence(origin, feed.origins.length < 2),
    ),
  );
  const additions: OriginEvidence[] = [];
  const siteUrl =
    evidence.find((entry) => entry.origin.kind === "atproto")?.siteUrl ??
    evidence.find((entry) => entry.origin.kind === "rss")?.siteUrl ??
    feed.siteUrl;
  if (evidence.length === 1 && siteUrl && evidence[0]!.itemUrls.size) {
    const rows = await dependencies.discoverFeedOriginsForRevalidation(siteUrl);
    const seen = new Set<string>();
    const candidates = rows
      .flatMap((row) => row.origins ?? [])
      .filter((origin) => {
        if (
          feed.origins.some((existing) => existing.kind === origin.kind) ||
          seen.has(origin.locator)
        )
          return false;
        seen.add(origin.locator);
        return true;
      })
      .slice(0, REVALIDATION_MAX_CANDIDATES);
    for (const candidate of candidates) {
      const observed = await dependencies.readOriginEvidence({
        ...candidate,
        alternateLocators:
          candidate.kind === "rss" ? candidate.alternateUrls : undefined,
      });
      if (originsShareArticles(evidence[0]!, observed)) {
        additions.push(observed);
        break;
      }
    }
  }
  return { evidence, additions };
}

/**
 * Feed revalidation. Resolves to the Feed as it stands after the pass, and
 * whether the pass changed its origins or what they say about themselves.
 * Its reads are discovery-side work.
 */
export async function revalidateFeed(
  database: typeof db,
  userId: string,
  feedId: number,
  dependencies: RevalidationDependencies = {
    readOriginEvidence,
    discoverFeedOriginsForRevalidation,
  },
) {
  const feed = await ownedFeed(database, userId, feedId);
  const { evidence, additions } = await withDiscoveryPacing(() =>
    observeOrigins(feed, dependencies),
  );
  // All network work finishes before the write lock. Re-read to preserve concurrent edits.
  const revalidated = await runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
        let syncRequested = false;
        let changed = false;
        let current = await ownedFeed(tx, userId, feedId);
        for (const addition of additions) {
          const existing = current.origins.find(
            (origin) => origin.kind === addition.origin.kind,
          );
          if (existing) continue;
          const match = await findFeedForOrigins(tx, userId, [addition.origin]);
          if (match && match.id !== feedId)
            throw new Error(FEED_ORIGIN_CONFLICT);
          current = await attachMissingFeedOrigins(tx, current, [
            addition.origin,
          ]);
          changed = true;
          // Only a publication joining the Feed changes a subscription.
          if (addition.origin.kind === "atproto")
            syncRequested = await requestSyncForFeedChange(tx, userId, [
              current.id,
            ]);
        }
        for (const observed of [...evidence, ...additions]) {
          const origin = current.origins.find(
            (entry) =>
              entry.kind === observed.origin.kind &&
              entry.locator === observed.origin.locator,
          );
          if (!origin) continue;
          // Each derivation must see the preceding origin update in this transaction.
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          const presented = await applyOriginMetadata(
            tx,
            { origin, feed: current },
            {
              name: observed.origin.sourceName ?? "",
              imageUrl: observed.origin.sourceImageUrl,
              description: observed.origin.sourceDescription,
              siteUrl: observed.siteUrl,
            },
          );
          changed ||= presented;
        }
        return {
          feed: feedsSchema.parse(await ownedFeed(tx, userId, feedId)),
          changed,
          syncRequested,
        };
      },
      { behavior: "immediate" },
    ),
  );
  wakeRequestedSync(database, revalidated.syncRequested);
  return { feed: revalidated.feed, changed: revalidated.changed };
}

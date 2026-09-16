import { and, eq } from "drizzle-orm";
import { discoverFeedOriginsForRevalidation } from "./discovery";
import {
  attachMissingFeedOrigins,
  FEED_ORIGIN_CONFLICT,
  findFeedForOrigins,
  withOrigins,
} from "./origins";
import {
  originsShareArticles,
  readOriginEvidence,
  REVALIDATION_MAX_CANDIDATES,
} from "./revalidationEvidence";
import type { FeedDatabase } from "./origins";
import type { OriginEvidence } from "./revalidationEvidence";
import type { db } from "~/server/db";
import { feeds, feedsSchema } from "~/server/db/schema";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { applyOriginMetadata } from "~/server/rss/originMetadata";

async function ownedFeed(
  database: FeedDatabase,
  userId: string,
  feedId: number,
) {
  const rows = await database
    .select()
    .from(feeds)
    .where(and(eq(feeds.id, feedId), eq(feeds.userId, userId)));
  const [feed] = await withOrigins(database, rows);
  if (!feed) throw new Error("Feed not found");
  return feed;
}

export async function revalidateFeed(
  database: typeof db,
  userId: string,
  feedId: number,
  dependencies = { readOriginEvidence, discoverFeedOriginsForRevalidation },
) {
  const feed = await ownedFeed(database, userId, feedId);
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
  // All network work finishes before the write lock. Re-read to preserve concurrent edits.
  return await runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
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
        }
        for (const observed of [...evidence, ...additions]) {
          const origin = current.origins.find(
            (entry) =>
              entry.kind === observed.origin.kind &&
              entry.locator === observed.origin.locator,
          );
          if (!origin) continue;
          await applyOriginMetadata(
            tx,
            { origin, feed: current },
            {
              name: observed.origin.sourceName ?? "",
              imageUrl: observed.origin.sourceImageUrl,
              description: observed.origin.sourceDescription,
              siteUrl: observed.siteUrl,
              pdsUrl: observed.origin.pdsUrl ?? undefined,
            },
          );
        }
        return feedsSchema.parse(await ownedFeed(tx, userId, feedId));
      },
      { behavior: "immediate" },
    ),
  );
}

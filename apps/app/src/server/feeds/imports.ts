import { and, eq, sql } from "drizzle-orm";
import { normalizePublicationUrl } from "@serial/standard-site";
import {
  createOrReuseFeed,
  FEED_ORIGIN_CONFLICT,
  findFeedForOrigins,
  withOrigins,
} from "./origins";
import {
  FeedImportDeferredError,
  FeedImportSkippedError,
} from "./importErrors";
import {
  originsShareArticles,
  readOriginEvidence,
  REVALIDATION_MAX_CANDIDATES,
} from "./revalidationEvidence";
import type { FeedDatabase } from "./origins";
import type { DatabaseFeedWithOrigins } from "~/server/db/schema";
import type { NewFeedDetails, NewFeedOriginDetails } from "~/server/rss/types";
import { feeds } from "~/server/db/schema";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";

export type PreparedFeedImport = {
  details: NewFeedDetails;
  target?: { id: number; origins: string };
  siteCandidates: string;
};

function originIdentity(origins: NewFeedOriginDetails[]) {
  return origins
    .map((origin) => `${origin.kind}:${origin.locator}`)
    .sort()
    .join("\n");
}

/** A site identifies candidates only. Article overlap is required before attachment. */
async function siteCandidates(
  database: FeedDatabase,
  userId: string,
  siteUrl: string | null | undefined,
) {
  const site = siteUrl && normalizePublicationUrl(siteUrl);
  if (!site) return [];
  const rows = await database
    .select()
    .from(feeds)
    .where(
      and(
        eq(feeds.userId, userId),
        sql`rtrim(substr(${feeds.siteUrl}, 1, min(instr(${feeds.siteUrl} || '?', '?'), instr(${feeds.siteUrl} || '#', '#')) - 1), '/') = ${site}`,
      ),
    )
    .limit(REVALIDATION_MAX_CANDIDATES + 1);
  if (rows.length > REVALIDATION_MAX_CANDIDATES)
    throw new FeedImportSkippedError();
  return withOrigins(database, rows);
}

function candidateIdentity(candidates: DatabaseFeedWithOrigins[]) {
  return candidates
    .map((feed) => `${feed.id}:${originIdentity(feed.origins)}`)
    .sort()
    .join("\n");
}

async function matchingFeed(
  database: FeedDatabase,
  userId: string,
  details: NewFeedDetails,
) {
  try {
    return await findFeedForOrigins(database, userId, details.origins);
  } catch (error) {
    if (error instanceof Error && error.message === FEED_ORIGIN_CONFLICT)
      throw new FeedImportSkippedError();
    throw error;
  }
}

/** Finish all network verification before a caller begins its write transaction. */
export async function prepareFeedImport(
  database: FeedDatabase,
  userId: string,
  details: NewFeedDetails,
  dependencies = { readOriginEvidence },
): Promise<PreparedFeedImport> {
  const exact = await matchingFeed(database, userId, details);
  const candidates = exact
    ? [exact]
    : await siteCandidates(database, userId, details.siteUrl);
  const siteSnapshot = exact ? "" : candidateIdentity(candidates);
  if (
    exact &&
    details.origins.every((origin) =>
      exact.origins.some((existing) => existing.kind === origin.kind),
    )
  ) {
    return {
      details,
      target: { id: exact.id, origins: originIdentity(exact.origins) },
      siteCandidates: siteSnapshot,
    };
  }
  if (!candidates.length) return { details, siteCandidates: siteSnapshot };
  const evidence = new Map<string, ReturnType<typeof readOriginEvidence>>();
  const read = (origin: NewFeedOriginDetails) => {
    const key = `${origin.kind}:${origin.locator}`;
    let pending = evidence.get(key);
    if (!pending) {
      pending = dependencies.readOriginEvidence(origin);
      evidence.set(key, pending);
    }
    return pending;
  };
  const matches: Array<{
    feed: DatabaseFeedWithOrigins;
    details: NewFeedDetails;
  }> = [];
  for (const candidate of candidates) {
    if (candidate.origins.length !== 1) continue;
    const existing = candidate.origins[0]!;
    const addition = details.origins.find(
      (origin) => origin.kind !== existing.kind,
    );
    if (!addition) continue;
    const [left, right] = await Promise.all([read(existing), read(addition)]);
    if (originsShareArticles(left, right)) {
      matches.push({
        feed: candidate,
        details: {
          ...details,
          origins: details.origins.some(
            (origin) => origin.kind === existing.kind,
          )
            ? details.origins
            : [...details.origins, left.origin],
        },
      });
    }
  }
  if (matches.length !== 1) throw new FeedImportSkippedError();
  const match = matches[0]!;
  return {
    details: match.details,
    target: { id: match.feed.id, origins: originIdentity(match.feed.origins) },
    siteCandidates: siteSnapshot,
  };
}

export async function prepareRssFeedImport(
  database: FeedDatabase,
  userId: string,
  url: string,
) {
  const [details] = await fetchNewFeedDetails(url);
  if (!details) throw new Error("Unsupported feed URL");
  return prepareFeedImport(database, userId, details);
}

/** Recheck the proof's target under the caller's write lock, preserving concurrent edits. */
export async function commitFeedImport(
  database: FeedDatabase,
  userId: string,
  prepared: PreparedFeedImport,
  isActive: boolean,
) {
  const current = await matchingFeed(database, userId, prepared.details);
  if (prepared.target) {
    if (
      current?.id !== prepared.target.id ||
      originIdentity(current.origins) !== prepared.target.origins
    ) {
      // A concurrent import which already added exactly these origins is harmless.
      if (
        current?.id !== prepared.target.id ||
        prepared.details.origins.some(
          (origin) =>
            !current.origins.some(
              (existing) =>
                existing.kind === origin.kind &&
                existing.locator === origin.locator,
            ),
        )
      ) {
        throw new FeedImportDeferredError(
          "Feed sources changed during import. Please try again.",
        );
      }
    }
  } else if (
    current ||
    candidateIdentity(
      await siteCandidates(database, userId, prepared.details.siteUrl),
    ) !== prepared.siteCandidates
  ) {
    throw new FeedImportDeferredError(
      "Feed sources changed during import. Please try again.",
    );
  }
  return createOrReuseFeed(database, {
    userId,
    details: prepared.details,
    isActive,
  });
}

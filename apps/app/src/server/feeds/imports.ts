import { and, eq, exists, inArray, sql } from "drizzle-orm";
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
import type {
  DatabaseFeedWithOrigins,
  FeedOriginKind,
} from "~/server/db/schema";
import type { NewFeedDetails, NewFeedOriginDetails } from "~/server/rss/types";
import { feedOrigins, feeds } from "~/server/db/schema";
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

/** The user's Feeds on a normalized site that hold an origin of one of `kinds`. */
function feedsOnSite(
  database: FeedDatabase,
  userId: string,
  site: string,
  kinds: FeedOriginKind[],
) {
  return and(
    eq(feeds.userId, userId),
    sql`rtrim(substr(${feeds.siteUrl}, 1, min(instr(${feeds.siteUrl} || '?', '?'), instr(${feeds.siteUrl} || '#', '#')) - 1), '/') = ${site}`,
    exists(
      database
        .select({ id: feedOrigins.id })
        .from(feedOrigins)
        .where(
          and(
            eq(feedOrigins.feedId, feeds.id),
            inArray(feedOrigins.kind, kinds),
          ),
        ),
    ),
  );
}

/** A site identifies candidates only. Article overlap is required before attachment. */
async function siteCandidates(
  database: FeedDatabase,
  userId: string,
  details: NewFeedDetails,
) {
  const site = details.siteUrl && normalizePublicationUrl(details.siteUrl);
  if (!site) return [];
  // Distinct RSS feeds on one site are valid. Only cross-origin candidates
  // require duplicate prevention; combined imports also check kind conflicts.
  const candidateKinds: FeedOriginKind[] =
    details.origins.length === 1
      ? [details.origins[0]!.kind === "rss" ? "atproto" : "rss"]
      : ["rss", "atproto"];
  const rows = await database
    .select()
    .from(feeds)
    .where(feedsOnSite(database, userId, site, candidateKinds))
    .limit(REVALIDATION_MAX_CANDIDATES + 1);
  if (rows.length > REVALIDATION_MAX_CANDIDATES)
    throw new FeedImportSkippedError();
  return withOrigins(database, rows);
}

/**
 * Whether the user already has a Feed with an RSS origin on a publication's
 * site. Only its address can match a guessed one, so only it needs discovery
 * to guess in full.
 */
export async function hasFeedOnSite(
  database: FeedDatabase,
  userId: string,
  siteUrl: string,
) {
  const site = normalizePublicationUrl(siteUrl);
  if (!site) return false;
  const [feed] = await database
    .select({ id: feeds.id })
    .from(feeds)
    .where(feedsOnSite(database, userId, site, ["rss"]))
    .limit(1);
  return feed !== undefined;
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

/** A matching Feed with an origin of every kind gains nothing from the import, so it needs no proof. */
function holdsEveryKind(
  feed: DatabaseFeedWithOrigins,
  origins: NewFeedOriginDetails[],
) {
  return origins.every((origin) =>
    feed.origins.some((existing) => existing.kind === origin.kind),
  );
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
    : await siteCandidates(database, userId, details);
  const siteSnapshot = exact ? "" : candidateIdentity(candidates);
  if (exact && holdsEveryKind(exact, details.origins)) {
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
    // A Feed has at most two origins and there are at most four candidates.
    // react-doctor-disable-next-line react-doctor/js-index-maps
    const sameKind = details.origins.find(
      (origin) => origin.kind === existing.kind,
    );
    if (
      sameKind &&
      // Verified alternates are bounded by discovery's eight-source budget.
      // react-doctor-disable-next-line react-doctor/js-set-map-lookups
      ![sameKind.locator, ...(sameKind.alternateLocators ?? [])].includes(
        existing.locator,
      )
    )
      continue;
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
    current
      ? // Another import created this Feed since the preparation, as a second
        // address of one Feed in an import file does. Reusing it joins nothing.
        !holdsEveryKind(current, prepared.details.origins)
      : candidateIdentity(
          await siteCandidates(database, userId, prepared.details),
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

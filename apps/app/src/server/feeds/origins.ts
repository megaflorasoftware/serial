import { and, asc, eq, inArray } from "drizzle-orm";
import type { db as defaultDatabase } from "~/server/db";
import type {
  DatabaseFeed,
  DatabaseFeedOrigin,
  DatabaseFeedWithOrigins,
} from "~/server/db/schema";
import type { FetchableOrigin, NewFeedDetails } from "~/server/rss/types";
import { runInChunks } from "~/server/api/routers/feed-router/utils";
import {
  FEED_ORIGIN_KIND,
  feedOrigins,
  feeds,
  feedsSchema,
  PLATFORM_DEFAULT_OPEN_LOCATION,
} from "~/server/db/schema";
import { parseArrayOfSchema } from "~/lib/schemas/utils";

/**
 * Any drizzle handle that can run the Feed and origin statements: the shared
 * database or a transaction opened on it. Structural so both satisfy it.
 */
export type FeedDatabase = Pick<
  typeof defaultDatabase,
  "select" | "insert" | "update" | "delete"
>;

export type FeedRow = { id: number; userId: string };

export const FEED_ORIGIN_CONFLICT =
  "These origins belong to different Feeds or conflict with an existing origin. No Feeds were changed.";

/** Two indexed locator lookups at most; legacy duplicate RSS locators keep the lowest-id match. */
export async function findFeedForOrigins(
  database: FeedDatabase,
  userId: string,
  origins: NewFeedDetails["origins"],
) {
  const matches = [];
  for (const origin of origins) {
    const [match] = await database
      .select({ feed: feeds })
      .from(feedOrigins)
      .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
      .where(
        and(
          eq(feeds.userId, userId),
          eq(feedOrigins.userId, userId),
          eq(feedOrigins.kind, origin.kind),
          eq(feedOrigins.locator, origin.locator),
        ),
      )
      .orderBy(asc(feedOrigins.feedId))
      .limit(1);
    if (match) matches.push(match.feed);
  }
  if (new Set(matches.map((feed) => feed.id)).size > 1)
    throw new Error(FEED_ORIGIN_CONFLICT);
  const match = matches[0];
  if (!match) return undefined;
  const [feed] = await withOrigins(database, [match]);
  if (!feed) return undefined;
  for (const origin of origins) {
    const existing = feed.origins.find((value) => value.kind === origin.kind);
    if (existing && existing.locator !== origin.locator)
      throw new Error(FEED_ORIGIN_CONFLICT);
  }
  return feed;
}

export async function attachMissingFeedOrigins(
  database: FeedDatabase,
  feed: DatabaseFeedWithOrigins,
  origins: NewFeedDetails["origins"],
) {
  const missing = origins.filter(
    (origin) => !feed.origins.some((existing) => existing.kind === origin.kind),
  );
  if (!missing.length) return feed;
  const inserted = await database
    .insert(feedOrigins)
    .values(
      missing.map((origin) => ({
        ...origin,
        feedId: feed.id,
        userId: feed.userId,
      })),
    )
    .returning();
  return { ...feed, origins: [...feed.origins, ...inserted] };
}

/** Attach origin rows to their Feed rows, preserving the Feed order given. */
export function attachOrigins<TFeed extends { id: number }>(
  feedRows: TFeed[],
  originRows: DatabaseFeedOrigin[],
): Array<TFeed & { origins: DatabaseFeedOrigin[] }> {
  const originsByFeedId = new Map<number, DatabaseFeedOrigin[]>();
  for (const origin of originRows) {
    const existing = originsByFeedId.get(origin.feedId);
    if (existing) existing.push(origin);
    else originsByFeedId.set(origin.feedId, [origin]);
  }
  return feedRows.map((feed) => ({
    ...feed,
    origins: originsByFeedId.get(feed.id) ?? [],
  }));
}

export async function loadOriginsForFeeds(
  database: FeedDatabase,
  feedIds: number[],
): Promise<DatabaseFeedOrigin[]> {
  if (feedIds.length === 0) return [];
  const chunks = await runInChunks(feedIds, (feedIdChunk) =>
    database
      .select()
      .from(feedOrigins)
      .where(inArray(feedOrigins.feedId, feedIdChunk))
      .orderBy(asc(feedOrigins.id)),
  );
  return chunks.flat();
}

/**
 * Every Feed a user owns with its origins nested, ordered by Feed id. One
 * left-joined statement so the reconciliation statement budget is unchanged;
 * a Feed with no origins still appears with an empty list.
 */
export async function loadUserFeedsWithOrigins(
  database: FeedDatabase,
  userId: string,
): Promise<DatabaseFeedWithOrigins[]> {
  const rows = await database
    .select({ feed: feeds, origin: feedOrigins })
    .from(feeds)
    .leftJoin(feedOrigins, eq(feedOrigins.feedId, feeds.id))
    .where(eq(feeds.userId, userId))
    .orderBy(asc(feeds.id), asc(feedOrigins.id));
  const feedRows: DatabaseFeed[] = [];
  const seenFeedIds = new Set<number>();
  const originRows: DatabaseFeedOrigin[] = [];
  for (const row of rows) {
    if (!seenFeedIds.has(row.feed.id)) {
      seenFeedIds.add(row.feed.id);
      feedRows.push(row.feed);
    }
    if (row.origin) originRows.push(row.origin);
  }
  return attachOrigins(feedRows, originRows);
}

/** Nest origins on already-loaded Feed rows. */
export async function withOrigins<TFeed extends DatabaseFeed>(
  database: FeedDatabase,
  feedRows: TFeed[],
): Promise<Array<TFeed & { origins: DatabaseFeedOrigin[] }>> {
  const originRows = await loadOriginsForFeeds(
    database,
    feedRows.map((feed) => feed.id),
  );
  return attachOrigins(feedRows, originRows);
}

export async function loadApplicationFeeds(
  database: FeedDatabase,
  feedRows: DatabaseFeed[],
) {
  return parseArrayOfSchema(await withOrigins(database, feedRows), feedsSchema);
}

/**
 * Find the user's Feed that already carries the given RSS locator. Dedupe is
 * a code-level lookup because legacy rows may share a URL; the lowest Feed id
 * wins, as the previous unordered `findFirst` on `feeds.url` did.
 */
export async function findFeedByRssUrl(
  database: FeedDatabase,
  input: { userId: string; feedUrl: string },
): Promise<DatabaseFeedWithOrigins | undefined> {
  const [match] = await database
    .select({ feed: feeds })
    .from(feedOrigins)
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .where(
      and(
        eq(feedOrigins.userId, input.userId),
        eq(feedOrigins.kind, FEED_ORIGIN_KIND.RSS),
        eq(feedOrigins.locator, input.feedUrl),
      ),
    )
    .orderBy(asc(feedOrigins.feedId))
    .limit(1);
  if (!match) return undefined;
  const [withNested] = await withOrigins(database, [match.feed]);
  return withNested;
}

/**
 * Feeds owned by the user whose RSS locator is in the given list, keyed by
 * locator. When legacy rows share a locator the highest Feed id wins, as the
 * previous map built from an unordered select did.
 */
export async function findFeedsByRssUrls(
  database: FeedDatabase,
  input: { userId: string; feedUrls: string[] },
): Promise<Map<string, DatabaseFeedWithOrigins>> {
  const result = new Map<string, DatabaseFeedWithOrigins>();
  if (input.feedUrls.length === 0) return result;
  const matches = (
    await runInChunks(input.feedUrls, (urlChunk) =>
      database
        .select({ feed: feeds, locator: feedOrigins.locator })
        .from(feedOrigins)
        .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
        .where(
          and(
            eq(feedOrigins.userId, input.userId),
            eq(feedOrigins.kind, FEED_ORIGIN_KIND.RSS),
            inArray(feedOrigins.locator, urlChunk),
          ),
        )
        .orderBy(asc(feedOrigins.feedId)),
    )
  ).flat();
  if (matches.length === 0) return result;
  const nested = await withOrigins(
    database,
    matches.map((match) => match.feed),
  );
  const feedById = new Map(nested.map((feed) => [feed.id, feed]));
  for (const match of matches) {
    const feed = feedById.get(match.feed.id);
    if (feed) result.set(match.locator, feed);
  }
  return result;
}

/**
 * Insert one Feed and the origin rows the parser produced, atomically when
 * the caller passes a transaction. Every Feed creation path goes through
 * here so a Feed never exists without its origins.
 */
export async function insertFeedWithOrigins(
  database: FeedDatabase,
  input: {
    userId: string;
    details: NewFeedDetails;
    isActive: boolean;
  },
): Promise<DatabaseFeedWithOrigins> {
  const { origins, ...feedValues } = input.details;
  const insertedFeeds = await database
    .insert(feeds)
    .values({
      userId: input.userId,
      ...feedValues,
      isActive: input.isActive,
      openLocation: PLATFORM_DEFAULT_OPEN_LOCATION[input.details.platform],
    })
    .returning();
  const insertedFeed = insertedFeeds[0];
  if (!insertedFeed) throw new Error("Couldn't find new feed");
  const insertedOrigins =
    origins.length > 0
      ? await database
          .insert(feedOrigins)
          .values(
            origins.map((origin) => ({
              ...origin,
              feedId: insertedFeed.id,
              userId: input.userId,
            })),
          )
          .returning()
      : [];
  return { ...insertedFeed, origins: insertedOrigins };
}

/** Flatten Feeds with nested origins into the pairs the fetch pipeline consumes. */
export function fetchableOriginsOf(
  feedRows: Array<DatabaseFeed & { origins: DatabaseFeedOrigin[] }>,
): FetchableOrigin[] {
  return feedRows.flatMap(({ origins, ...feed }) =>
    origins.map((origin) => ({ origin, feed })),
  );
}

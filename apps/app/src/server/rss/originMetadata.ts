import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { platformOfContentType } from "@serial/standard-site";
import { runDatabaseWrite } from "../db/retry-write";
import {
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feedOrigins,
  feeds,
} from "../db/schema";
import type { ContentPlatform } from "~/lib/content/descriptor";
import type { FeedDatabase } from "~/server/feeds/origins";
import type { db } from "../db";
import type { DatabaseFeed, DatabaseFeedOrigin } from "../db/schema";
import { CONTENT_PLATFORM, isVideoPlatform } from "~/lib/content/descriptor";
import { FEED_ORIGIN_KIND } from "~/server/db/schema";
import { dbSemaphore } from "~/lib/semaphore";

type MetadataOrigin = {
  feed: Pick<DatabaseFeed, "id" | "name" | "siteUrl" | "platform">;
  origin: DatabaseFeedOrigin;
};

type OriginMetadata = {
  name: string;
  imageUrl?: string | null;
  description?: string | null;
  siteUrl?: string | null;
};

/** What the source says about itself, in the shape its origin row stores it. */
function sourceFields(metadata: OriginMetadata) {
  return {
    sourceName: metadata.name,
    sourceImageUrl: metadata.imageUrl ?? null,
    sourceDescription: metadata.description ?? null,
  };
}

function sourceDiffers(origin: DatabaseFeedOrigin, metadata: OriginMetadata) {
  const next = sourceFields(metadata);
  return (
    next.sourceName !== origin.sourceName ||
    next.sourceImageUrl !== origin.sourceImageUrl ||
    next.sourceDescription !== origin.sourceDescription
  );
}

async function hasPublicationOrigin(database: FeedDatabase, feedId: number) {
  const publication = await database
    .select({ id: feedOrigins.id })
    .from(feedOrigins)
    .where(
      and(
        eq(feedOrigins.feedId, feedId),
        eq(feedOrigins.kind, FEED_ORIGIN_KIND.ATPROTO),
      ),
    )
    .get();
  return publication !== undefined;
}

/**
 * An RSS fetch's metadata. A feed that says what it said last time writes
 * nothing and opens no transaction. A site URL that differs matters only
 * where no Publication owns the Feed's, which one narrow read settles. The
 * platform is left alone: an RSS fetch cannot change the Atmosphere side.
 */
export async function refreshOriginMetadata(
  database: typeof db,
  { origin, feed }: MetadataOrigin,
  metadata: OriginMetadata,
) {
  const siteUrlDiffers =
    !!metadata.siteUrl && metadata.siteUrl !== feed.siteUrl;
  if (
    !sourceDiffers(origin, metadata) &&
    !(siteUrlDiffers && !(await hasPublicationOrigin(database, feed.id)))
  )
    return false;
  return runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(
        async (tx) =>
          applyOriginMetadata(tx, { origin, feed }, metadata, {
            platform: false,
          }),
        { behavior: "immediate" },
      ),
    ),
  );
}

/**
 * Stores what a source says about itself and derives the Feed's name, image
 * and site URL from its origins. Each write happens only where the stored
 * value differs, so the Feed's `updated_at` moves only when the Feed did.
 * Returns whether anything changed.
 */
export async function applyOriginMetadata(
  database: FeedDatabase,
  { origin, feed }: MetadataOrigin,
  metadata: OriginMetadata,
  { platform }: { platform: boolean } = { platform: true },
) {
  const sourceChanged = sourceDiffers(origin, metadata);
  if (sourceChanged)
    await database
      .update(feedOrigins)
      .set({ ...sourceFields(metadata), updatedAt: new Date() })
      .where(eq(feedOrigins.id, origin.id));
  const origins = await database
    .select()
    .from(feedOrigins)
    .where(eq(feedOrigins.feedId, feed.id));
  const publication = origins.find(
    (item) => item.kind === FEED_ORIGIN_KIND.ATPROTO,
  );
  const rss = origins.find((item) => item.kind === FEED_ORIGIN_KIND.RSS);
  const name = publication?.sourceName || rss?.sourceName || feed.name;
  const imageUrl = publication?.sourceImageUrl || rss?.sourceImageUrl || "";
  const presented = await database
    .update(feeds)
    .set({
      name: sql`case when ${feeds.nameEditedAt} is null then ${name} else ${feeds.name} end`,
      imageUrl,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(feeds.id, feed.id),
        or(
          sql`${feeds.imageUrl} is not ${imageUrl}`,
          and(isNull(feeds.nameEditedAt), sql`${feeds.name} is not ${name}`),
        ),
      ),
    );
  const ownsSiteUrl =
    !!metadata.siteUrl &&
    (!publication || origin.kind === FEED_ORIGIN_KIND.ATPROTO);
  const located = ownsSiteUrl
    ? await database
        .update(feeds)
        .set({ siteUrl: metadata.siteUrl, updatedAt: new Date() })
        .where(
          and(
            eq(feeds.id, feed.id),
            sql`${feeds.siteUrl} is not ${metadata.siteUrl}`,
          ),
        )
    : undefined;
  const platformChanged =
    platform && publication
      ? await recomputeFeedPlatform(database, feed, publication.id)
      : false;
  return (
    sourceChanged ||
    presented.rowsAffected > 0 ||
    (located?.rowsAffected ?? 0) > 0 ||
    platformChanged
  );
}

/** The content type at one end of the origin's readable versions, by one index seek. */
function edgeContentType(
  database: FeedDatabase,
  originId: number,
  order: typeof asc,
) {
  return database
    .select({ type: feedOriginAtprotoDocuments.bodyContentType })
    .from(feedOriginAtprotoDocuments)
    .where(
      and(
        eq(feedOriginAtprotoDocuments.originId, originId),
        isNotNull(feedOriginAtprotoDocuments.bodyContentType),
      ),
    )
    .orderBy(order(feedOriginAtprotoDocuments.bodyContentType))
    .limit(1);
}

/**
 * The platform the origin's readable versions agree on: the content `$type`
 * each was stored with, mapped through the adapter registry. `website` when
 * they disagree or when nothing readable is retained. The lowest and highest
 * types bound every other, so two index seeks decide it however long the
 * history is; types between two that map to one platform are not consulted.
 */
export async function atmospherePlatformOf(
  database: FeedDatabase,
  originId: number,
): Promise<ContentPlatform> {
  const [edges] = await database
    .select({
      lowest: sql<string | null>`(${edgeContentType(database, originId, asc)})`,
      highest: sql<
        string | null
      >`(${edgeContentType(database, originId, desc)})`,
    })
    .from(feedOriginAtproto)
    .where(eq(feedOriginAtproto.originId, originId));
  if (!edges || edges.lowest === null || edges.highest === null)
    return CONTENT_PLATFORM.WEBSITE;
  const platform = platformOfContentType(edges.lowest);
  return platform === platformOfContentType(edges.highest)
    ? platform
    : CONTENT_PLATFORM.WEBSITE;
}

/**
 * Recomputes a Feed's platform from its Atmosphere origin's readable versions.
 * The stored platform stands in for the RSS side: a video platform is left
 * alone, since RSS video wins over Atmosphere; otherwise the agreed Atmosphere
 * platform is written, `website` when the versions disagree or none exist.
 * Returns whether the stored platform changed.
 */
export async function recomputeFeedPlatform(
  database: FeedDatabase,
  feed: Pick<DatabaseFeed, "id" | "platform">,
  originId: number,
) {
  const current = feed.platform;
  if (isVideoPlatform(current)) return false;
  const platform = await atmospherePlatformOf(database, originId);
  if (platform === current) return false;
  await database
    .update(feeds)
    .set({ platform, updatedAt: new Date() })
    .where(eq(feeds.id, feed.id));
  return true;
}

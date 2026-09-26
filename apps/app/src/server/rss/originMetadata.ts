import { and, eq, sql } from "drizzle-orm";
import { platformOfContentType } from "@serial/standard-site";
import { runDatabaseWrite } from "../db/retry-write";
import {
  feedOriginAtprotoDocuments,
  feedOriginAtprotoDocumentSources,
  feedOrigins,
  feeds,
} from "../db/schema";
import { CONTENT_PLATFORM, isVideoPlatform } from "~/lib/content/descriptor";
import type { ContentPlatform } from "~/lib/content/descriptor";
import type { FeedDatabase } from "~/server/feeds/origins";
import type { db } from "../db";
import type { DatabaseFeed, DatabaseFeedOrigin } from "../db/schema";
import { dbSemaphore } from "~/lib/semaphore";

type MetadataOrigin = { feed: DatabaseFeed; origin: DatabaseFeedOrigin };

export async function refreshOriginMetadata(
  database: typeof db,
  { origin, feed }: MetadataOrigin,
  metadata: OriginMetadata,
) {
  return runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(
        async (tx) => {
          return applyOriginMetadata(tx, { origin, feed }, metadata);
        },
        { behavior: "immediate" },
      ),
    ),
  );
}

type OriginMetadata = {
  name: string;
  imageUrl?: string | null;
  description?: string | null;
  siteUrl?: string | null;
};

export async function applyOriginMetadata(
  database: FeedDatabase,
  { origin, feed }: MetadataOrigin,
  metadata: OriginMetadata,
) {
  await database
    .update(feedOrigins)
    .set({
      sourceName: metadata.name,
      sourceImageUrl: metadata.imageUrl ?? null,
      sourceDescription: metadata.description ?? null,
      updatedAt: new Date(),
    })
    .where(eq(feedOrigins.id, origin.id));
  const origins = await database
    .select()
    .from(feedOrigins)
    .where(eq(feedOrigins.feedId, feed.id));
  const publication = origins.find((item) => item.kind === "atproto");
  const rss = origins.find((item) => item.kind === "rss");
  await database
    .update(feeds)
    .set({
      name: sql`case when ${feeds.nameEditedAt} is null then ${publication?.sourceName || rss?.sourceName || feed.name} else ${feeds.name} end`,
      imageUrl: publication?.sourceImageUrl || rss?.sourceImageUrl || "",
      updatedAt: new Date(),
    })
    .where(eq(feeds.id, feed.id));
  const shouldUpdateSiteUrl =
    !!metadata.siteUrl && (!publication || origin.kind === "atproto");
  if (shouldUpdateSiteUrl)
    await database
      .update(feeds)
      .set({ siteUrl: metadata.siteUrl })
      .where(eq(feeds.id, feed.id));
  const platformChanged = publication
    ? await recomputeFeedPlatform(database, feed, publication.id)
    : false;
  return (
    platformChanged ||
    metadata.name !== origin.sourceName ||
    (metadata.imageUrl ?? null) !== origin.sourceImageUrl ||
    (metadata.description ?? null) !== origin.sourceDescription ||
    (shouldUpdateSiteUrl && metadata.siteUrl !== feed.siteUrl)
  );
}

/**
 * The platform the origin's retained document sources agree on: the content
 * `$type` of each readable version, mapped through the adapter registry.
 * `website` when they disagree or when nothing readable is retained.
 */
export async function atmospherePlatformOf(
  database: FeedDatabase,
  originId: number,
): Promise<ContentPlatform> {
  const rows: Array<{ contentType: string | null }> = await database
    .select({
      contentType: sql<
        string | null
      >`distinct json_extract(${feedOriginAtprotoDocumentSources.record}, '$.content."$type"')`,
    })
    .from(feedOriginAtprotoDocuments)
    .innerJoin(
      feedOriginAtprotoDocumentSources,
      and(
        eq(
          feedOriginAtprotoDocumentSources.originId,
          feedOriginAtprotoDocuments.originId,
        ),
        eq(feedOriginAtprotoDocumentSources.uri, feedOriginAtprotoDocuments.uri),
        eq(
          feedOriginAtprotoDocumentSources.cid,
          feedOriginAtprotoDocuments.bodyCid,
        ),
      ),
    )
    .where(
      and(
        eq(feedOriginAtprotoDocuments.originId, originId),
        eq(feedOriginAtprotoDocuments.status, "ready"),
      ),
    )
    .limit(2);
  const platforms = new Set<ContentPlatform>(
    rows.map((row) => platformOfContentType(row.contentType)),
  );
  const [platform] = platforms;
  return platforms.size === 1 && platform ? platform : CONTENT_PLATFORM.WEBSITE;
}

/**
 * Recomputes a Feed's platform from its Atmosphere origin's retained sources.
 * The stored platform stands in for the RSS side: a video platform is left
 * alone, since RSS video wins over Atmosphere; otherwise the agreed Atmosphere
 * platform is written, `website` when the sources disagree or none exist.
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

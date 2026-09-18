import { eq, sql } from "drizzle-orm";
import { runDatabaseWrite } from "../db/retry-write";
import { feedOrigins, feeds } from "../db/schema";
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
  return (
    metadata.name !== origin.sourceName ||
    (metadata.imageUrl ?? null) !== origin.sourceImageUrl ||
    (metadata.description ?? null) !== origin.sourceDescription ||
    (shouldUpdateSiteUrl && metadata.siteUrl !== feed.siteUrl)
  );
}

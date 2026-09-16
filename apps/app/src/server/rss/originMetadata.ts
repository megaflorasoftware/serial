import { and, eq, isNull } from "drizzle-orm";
import { runDatabaseWrite } from "../db/retry-write";
import { feedOrigins, feeds } from "../db/schema";
import type { db } from "../db";
import type { FetchableOrigin } from "./types";
import { dbSemaphore } from "~/lib/semaphore";

export async function refreshOriginMetadata(
  database: typeof db,
  { origin, feed }: FetchableOrigin,
  metadata: {
    name: string;
    imageUrl?: string | null;
    description?: string | null;
    siteUrl?: string | null;
    pdsUrl?: string;
  },
) {
  return runDatabaseWrite(database, () =>
    dbSemaphore.run(() =>
      database.transaction(
        async (tx) => {
          await tx
            .update(feedOrigins)
            .set({
              sourceName: metadata.name,
              sourceImageUrl: metadata.imageUrl ?? null,
              sourceDescription: metadata.description ?? null,
              ...(metadata.pdsUrl ? { pdsUrl: metadata.pdsUrl } : {}),
              updatedAt: new Date(),
            })
            .where(eq(feedOrigins.id, origin.id));
          const origins = await tx
            .select()
            .from(feedOrigins)
            .where(eq(feedOrigins.feedId, feed.id));
          const publication = origins.find((item) => item.kind === "atproto");
          const rss = origins.find((item) => item.kind === "rss");
          await tx
            .update(feeds)
            .set({
              name: publication?.sourceName || rss?.sourceName || feed.name,
              imageUrl:
                publication?.sourceImageUrl || rss?.sourceImageUrl || "",
              updatedAt: new Date(),
            })
            .where(and(eq(feeds.id, feed.id), isNull(feeds.nameEditedAt)));
          const shouldUpdateSiteUrl =
            !!metadata.siteUrl && (!publication || origin.kind === "atproto");
          if (shouldUpdateSiteUrl)
            await tx
              .update(feeds)
              .set({ siteUrl: metadata.siteUrl })
              .where(eq(feeds.id, feed.id));
          return (
            metadata.name !== origin.sourceName ||
            (metadata.imageUrl ?? null) !== origin.sourceImageUrl ||
            (metadata.description ?? null) !== origin.sourceDescription ||
            (shouldUpdateSiteUrl && metadata.siteUrl !== feed.siteUrl)
          );
        },
        { behavior: "immediate" },
      ),
    ),
  );
}

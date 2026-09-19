import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import { verifyFeedsOwnedByUser } from "./feed-router/utils";
import type { ApplicationFeedItem } from "~/server/db/schema";
import type { FetchFeedsStatus } from "~/server/rss/fetchFeeds";
import { prepareArrayChunks } from "~/lib/iterators";
import { feedItems, feeds } from "~/server/db/schema";
import { protectedProcedure } from "~/server/orpc/base";
import { fetchableOriginsOf, withOrigins } from "~/server/feeds/origins";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import {
  loadReaderBodies,
  ownedBodyRow,
  refreshDocumentReferences,
  toApplicationFeedItem,
} from "~/server/feeds/reader-bodies";
import {
  deduplicateByLastValue,
  MAX_BULK_MUTATION_ITEMS,
} from "~/lib/schemas/bulk";
import {
  ALL_CONTENT_STATUS_KEYS,
  buildFeedInvalidationSummary,
  contentStatusKeysAroundChange,
} from "~/lib/reconciliation";
import { publishReconciliationInvalidation } from "~/server/reconciliation/invalidation";

type FeedItemsChunk =
  | {
      type: "feed-items";
      feedItems: ApplicationFeedItem[];
      hasMore?: boolean;
      nextCursor?: { postedAt: Date; id: string } | null;
    }
  | {
      type: "feed-status";
      feedId: number;
      status: FetchFeedsStatus;
    };

export const setWatchedValue = protectedProcedure
  .input(
    z.object({
      id: z.string(),
      feedId: z.number(),
      isWatched: z.boolean(),
    }),
  )
  .handler(async ({ context, input }) => {
    const updatedAt = new Date();
    const result = await context.db.transaction(async (tx) => {
      const isOwned = await verifyFeedsOwnedByUser({
        feedIds: [input.feedId],
        userId: context.user.id,
        db: tx,
      });

      if (!isOwned) {
        throw new Error("Unauthorized: Feed does not belong to user");
      }

      const [updatedItem] = await tx
        .update(feedItems)
        .set({
          isWatched: input.isWatched,
          isWatchedUpdatedAt: input.isWatched ? updatedAt : null,
          updatedAt,
        })
        .where(
          and(eq(feedItems.feedId, input.feedId), eq(feedItems.id, input.id)),
        )
        .returning({
          id: feedItems.id,
          feedId: feedItems.feedId,
          contentId: feedItems.contentId,
          title: feedItems.title,
          author: feedItems.author,
          url: feedItems.url,
          thumbnail: feedItems.thumbnail,
          contentSnippet: feedItems.contentSnippet,
          contentType: feedItems.contentType,
          isWatched: feedItems.isWatched,
          isWatchedUpdatedAt: feedItems.isWatchedUpdatedAt,
          isWatchLater: feedItems.isWatchLater,
          isWatchLaterUpdatedAt: feedItems.isWatchLaterUpdatedAt,
          progress: feedItems.progress,
          duration: feedItems.duration,
          orientation: feedItems.orientation,
          postedAt: feedItems.postedAt,
          createdAt: feedItems.createdAt,
          updatedAt: feedItems.updatedAt,
          contentHash: feedItems.contentHash,
        });

      if (!updatedItem) {
        throw new Error("Feed item not found");
      }

      return updatedItem;
    });

    await publishReconciliationInvalidation(
      context.user.id,
      buildFeedInvalidationSummary({
        feedIds: [input.feedId],
        contentStatusKeys: contentStatusKeysAroundChange({
          saveStatuses: [result.isWatchLater ? "saved" : "inbox"],
          archiveStatuses: ["unread", "archived"],
        }),
      }),
    );

    return {
      id: result.id,
      isWatched: result.isWatched,
      isWatchedUpdatedAt: result.isWatchedUpdatedAt,
      updatedAt: result.updatedAt,
    };
  });

export const setBulkWatchedValue = protectedProcedure
  .input(
    z.object({
      items: z
        .array(
          z.object({
            id: z.string(),
            feedId: z.number(),
          }),
        )
        .max(MAX_BULK_MUTATION_ITEMS)
        .transform((values) =>
          deduplicateByLastValue(
            values,
            (value) => `${value.feedId}:${value.id}`,
          ),
        ),
      isWatched: z.boolean(),
    }),
  )
  .handler(async ({ context, input }) => {
    if (input.items.length === 0) return;

    const updatedAt = new Date();
    const result = await context.db.transaction(async (tx) => {
      // Extract unique feedIds and verify ownership
      const feedIds = [...new Set(input.items.map((item) => item.feedId))];

      const isOwned = await verifyFeedsOwnedByUser({
        feedIds,
        userId: context.user.id,
        db: tx,
      });

      if (!isOwned) {
        throw new Error(
          "Unauthorized: One or more feeds do not belong to user",
        );
      }

      // Bulk update using inArray
      const itemIds = input.items.map((item) => item.id);
      return tx
        .update(feedItems)
        .set({
          isWatched: input.isWatched,
          isWatchedUpdatedAt: input.isWatched ? updatedAt : null,
          updatedAt,
        })
        .where(inArray(feedItems.id, itemIds))
        .returning({
          id: feedItems.id,
          isWatched: feedItems.isWatched,
          isWatchedUpdatedAt: feedItems.isWatchedUpdatedAt,
          updatedAt: feedItems.updatedAt,
        });
    });
    await publishReconciliationInvalidation(
      context.user.id,
      buildFeedInvalidationSummary({
        feedIds: input.items.map(({ feedId }) => feedId),
        contentStatusKeys: ALL_CONTENT_STATUS_KEYS,
      }),
    );
    return result;
  });

export const setWatchLaterValue = protectedProcedure
  .input(
    z.object({
      id: z.string(),
      feedId: z.number(),
      isWatchLater: z.boolean(),
    }),
  )
  .handler(async ({ context, input }) => {
    const updatedAt = new Date();
    const result = await context.db.transaction(async (tx) => {
      const isOwned = await verifyFeedsOwnedByUser({
        feedIds: [input.feedId],
        userId: context.user.id,
        db: tx,
      });

      if (!isOwned) {
        throw new Error("Unauthorized: Feed does not belong to user");
      }

      const [updatedItem] = await tx
        .update(feedItems)
        .set({
          isWatchLater: input.isWatchLater,
          isWatchLaterUpdatedAt: updatedAt,
          updatedAt,
        })
        .where(
          and(eq(feedItems.feedId, input.feedId), eq(feedItems.id, input.id)),
        )
        .returning({
          id: feedItems.id,
          feedId: feedItems.feedId,
          contentId: feedItems.contentId,
          title: feedItems.title,
          author: feedItems.author,
          url: feedItems.url,
          thumbnail: feedItems.thumbnail,
          contentSnippet: feedItems.contentSnippet,
          contentType: feedItems.contentType,
          isWatched: feedItems.isWatched,
          isWatchedUpdatedAt: feedItems.isWatchedUpdatedAt,
          isWatchLater: feedItems.isWatchLater,
          isWatchLaterUpdatedAt: feedItems.isWatchLaterUpdatedAt,
          progress: feedItems.progress,
          duration: feedItems.duration,
          orientation: feedItems.orientation,
          postedAt: feedItems.postedAt,
          createdAt: feedItems.createdAt,
          updatedAt: feedItems.updatedAt,
          contentHash: feedItems.contentHash,
        });

      if (!updatedItem) {
        throw new Error("Feed item not found");
      }

      return updatedItem;
    });

    await publishReconciliationInvalidation(
      context.user.id,
      buildFeedInvalidationSummary({
        feedIds: [input.feedId],
        contentStatusKeys: contentStatusKeysAroundChange({
          saveStatuses: ["inbox", "saved"],
          archiveStatuses: [result.isWatched ? "archived" : "unread"],
        }),
      }),
    );

    return {
      id: result.id,
      isWatchLater: result.isWatchLater,
      isWatchLaterUpdatedAt: result.isWatchLaterUpdatedAt,
      updatedAt: result.updatedAt,
    };
  });

export const setProgress = protectedProcedure
  .input(
    z.object({
      id: z.string(),
      feedId: z.number(),
      progress: z.number().int().min(0),
      duration: z.number().int().min(0),
    }),
  )
  .handler(async ({ context, input }) => {
    await context.db.transaction(async (tx) => {
      const isOwned = await verifyFeedsOwnedByUser({
        feedIds: [input.feedId],
        userId: context.user.id,
        db: tx,
      });

      if (!isOwned) {
        throw new Error("Unauthorized: Feed does not belong to user");
      }

      await tx
        .update(feedItems)
        .set({
          progress: input.progress,
          duration: input.duration,
          updatedAt: new Date(),
        })
        .where(
          and(eq(feedItems.feedId, input.feedId), eq(feedItems.id, input.id)),
        );
    });
  });

export const getById = protectedProcedure
  .input(z.object({ id: z.string() }))
  .handler(async ({ context, input }) => {
    const item = await context.db.query.feedItems.findFirst({
      where: eq(feedItems.id, input.id),
    });

    if (!item) {
      return null;
    }

    const feed = await context.db.query.feeds.findFirst({
      where: and(eq(feeds.id, item.feedId), eq(feeds.userId, context.user.id)),
    });

    if (!feed) {
      return null;
    }

    // Direct open is one of the two paths that carry a Reader body.
    const bodies = await loadReaderBodies(context.db, [item]);
    return toApplicationFeedItem(item, feed.platform, bodies.get(item.id));
  });

export const refreshReferences = protectedProcedure
  .input(z.object({ id: z.string() }))
  .handler(async ({ context, input }) => {
    const row = await ownedBodyRow(context.db, context.user.id, input.id);
    if (!row) return null;
    return refreshDocumentReferences(context.db, row);
  });

export const getByFeedId = protectedProcedure
  .input(
    z.object({
      feedId: z.number(),
      cursor: z
        .object({ postedAt: z.coerce.date(), id: z.string() })
        .optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  )
  .handler(async function* ({
    context,
    input,
  }): AsyncGenerator<FeedItemsChunk> {
    const feed = await context.db.query.feeds.findFirst({
      where: and(eq(feeds.id, input.feedId), eq(feeds.userId, context.user.id)),
    });

    if (!feed) {
      return;
    }

    const limit = input.limit ?? 50;
    const cursorFilter = input.cursor
      ? or(
          lt(feedItems.postedAt, input.cursor.postedAt),
          and(
            eq(feedItems.postedAt, input.cursor.postedAt),
            lt(feedItems.id, input.cursor.id),
          ),
        )
      : undefined;
    // Bodies never ride list queries; they travel through the body endpoint.
    const itemsData = await context.db.query.feedItems.findMany({
      where: and(eq(feedItems.feedId, input.feedId), cursorFilter),
      orderBy: [desc(feedItems.postedAt), desc(feedItems.id)],
      limit: limit + 1,
      columns: { content: false },
    });
    const hasMore = itemsData.length > limit;
    const itemsToReturn = itemsData.slice(0, limit);
    const lastItem = itemsToReturn.at(-1);

    const existingApplicationFeedItems = itemsToReturn.map((item) =>
      toApplicationFeedItem({ ...item, content: "" }, feed.platform),
    );

    for (const chunk of prepareArrayChunks(existingApplicationFeedItems, 50)) {
      yield {
        type: "feed-items",
        feedItems: chunk,
        hasMore,
        nextCursor:
          hasMore && lastItem
            ? { postedAt: lastItem.postedAt, id: lastItem.id }
            : null,
      };
    }

    if (input.cursor) {
      return;
    }

    for await (const feedResult of fetchAndInsertFeedData(
      context,
      fetchableOriginsOf(await withOrigins(context.db, [feed])),
    )) {
      yield {
        type: "feed-status",
        status: feedResult.status,
        feedId: feedResult.id,
      };

      if (feedResult.status !== "success") {
        continue;
      }

      for (const chunk of prepareArrayChunks(feedResult.feedItems, 50)) {
        yield {
          type: "feed-items",
          feedItems: chunk,
        };
      }
    }

    return;
  });

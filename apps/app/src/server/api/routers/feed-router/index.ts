import { discoveredFeedSchema } from "@serial/feed-discovery/schema";
import { DISCOVERY_QUERY_LIMIT } from "@serial/feed-discovery";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  insertFeedWithCategories,
  verifyContentCategoriesOwnedByUser,
  verifyViewsOwnedByUser,
} from "./utils";
import { revalidateFeed } from "~/server/feeds/revalidate";
import { captureLimiter } from "~/server/bookmarks/limits";
import { deleteUserFeeds } from "~/server/feeds/delete";
import { loadUserFeedsWithOrigins, withOrigins } from "~/server/feeds/origins";
import { captureException } from "~/server/logger";
import { parseArrayOfSchema } from "~/lib/schemas/utils";

import { prepareArrayChunks } from "~/lib/iterators";
import { dbSemaphore } from "~/lib/semaphore";
import {
  feedCategories,
  feeds,
  feedsSchema,
  openLocationSchema,
  viewFeeds,
} from "~/server/db/schema";
import { protectedProcedure } from "~/server/orpc/base";
import { prepareRssFeedImport } from "~/server/feeds/imports";
import { runDatabaseWrite } from "~/server/db/retry-write";
import {
  canActivateFeed,
  getFeedsActivationBudget,
  getUserPlanId,
  isAdminUser,
} from "~/server/subscriptions/helpers";
import { getEffectivePlanConfig } from "~/server/subscriptions/plans";
import { createFeedsForUser } from "~/server/feeds/create";
import { discoverFeeds as discoverFeedsForUrl } from "~/server/feeds/discovery";
import {
  boundedNumberIdsSchema,
  boundedStringsSchema,
  MAX_BULK_MUTATION_ITEMS,
} from "~/lib/schemas/bulk";
import {
  organizationInvalidationSummary,
  publishReconciliationInvalidation,
} from "~/server/reconciliation/invalidation";

type BulkImportFromFileSuccess = {
  feedUrl: string;
  feedId: number;
  success: true;
};
type BulkImportFromFileError = {
  feedUrl: string;
  success: false;
  error: string;
};
export type BulkImportFromFileResult =
  BulkImportFromFileError | BulkImportFromFileSuccess;

const createFeedInputSchema = z.object({
  selection: discoveredFeedSchema.optional(),
  url: z.string().min(5),
  categoryIds: boundedNumberIdsSchema,
  viewIds: boundedNumberIdsSchema.optional(),
});

export const create = protectedProcedure
  .input(createFeedInputSchema)
  .handler(async ({ context, input }) => {
    const result = await createFeedsForUser({
      database: context.db,
      userId: context.user.id,
      ...input,
    });
    await publishReconciliationInvalidation(
      context.user.id,
      organizationInvalidationSummary(),
    );
    return result;
  });

export const createFromSubscriptionImport = protectedProcedure
  .input(
    z.object({
      feeds: z
        .object({
          feedUrl: z.string(),
          categories: boundedStringsSchema,
        })
        .array()
        .max(MAX_BULK_MUTATION_ITEMS),
    }),
  )
  .handler(async ({ context, input }): Promise<BulkImportFromFileResult[]> => {
    if (!input.feeds.length) {
      return [];
    }

    // Check activation budget upfront and pre-calculate which feeds should be active
    const { maxActiveFeeds } = await getFeedsActivationBudget(
      context.db,
      context.user.id,
    );

    // Process feeds in small batches to avoid overwhelming the database
    const BATCH_SIZE = 4;
    const feedChunks = prepareArrayChunks(input.feeds, BATCH_SIZE);
    const allResults: BulkImportFromFileResult[] = [];
    const userId = context.user.id;

    for (const chunk of feedChunks) {
      const promiseResults = await Promise.allSettled(
        chunk.map(async (feed) => {
          const prepared = await prepareRssFeedImport(
            context.db,
            userId,
            feed.feedUrl,
          );
          const result = await dbSemaphore.run(() =>
            runDatabaseWrite(context.db, () =>
              context.db.transaction(
                (tx) =>
                  insertFeedWithCategories(
                    tx,
                    userId,
                    feed,
                    prepared,
                    maxActiveFeeds,
                  ),
                { behavior: "immediate" },
              ),
            ),
          );
          return result.success
            ? {
                feedUrl: feed.feedUrl,
                feedId: result.feedId,
                success: true as const,
              }
            : {
                feedUrl: feed.feedUrl,
                success: false as const,
                error: result.error,
              };
        }),
      );

      const chunkResults: BulkImportFromFileResult[] = promiseResults.map(
        (result, i): BulkImportFromFileResult => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          captureException(result.reason, {
            context: "bulk-feed-import",
            feedUrl: chunk[i]?.feedUrl,
          });
          return {
            feedUrl: chunk[i]?.feedUrl ?? "unknown",
            success: false as const,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Import failed",
          };
        },
      );

      allResults.push(...chunkResults);
    }

    if (allResults.some((result) => result.success)) {
      await publishReconciliationInvalidation(
        context.user.id,
        organizationInvalidationSummary(),
      );
    }
    return allResults;
  });

const deleteFeed = protectedProcedure
  .input(z.number())
  .handler(async ({ context, input }) => {
    await context.db.transaction((tx) =>
      deleteUserFeeds(tx, context.user.id, [input]),
    );
    await publishReconciliationInvalidation(
      context.user.id,
      organizationInvalidationSummary(),
    );
  });
export { deleteFeed as delete };

export const getAll = protectedProcedure.handler(async function* ({ context }) {
  const feedsList = await loadUserFeedsWithOrigins(context.db, context.user.id);

  const parsed = parseArrayOfSchema(feedsList, feedsSchema);

  for (const chunk of prepareArrayChunks(parsed, 50)) {
    yield chunk;
  }

  return;
});

export const update = protectedProcedure
  .input(
    z.object({
      feedId: z.number(),
      categoryIds: boundedNumberIdsSchema,
      viewIds: boundedNumberIdsSchema.optional(),
      openLocation: openLocationSchema,
      name: z.string().min(1).max(256),
    }),
  )
  .handler(async ({ context, input }) => {
    const result = await context.db.transaction(async (tx) => {
      const [categoriesOwned, viewsOwned] = await Promise.all([
        verifyContentCategoriesOwnedByUser({
          categoryIds: input.categoryIds,
          userId: context.user.id,
          db: tx,
        }),
        verifyViewsOwnedByUser({
          viewIds: input.viewIds ?? [],
          userId: context.user.id,
          db: tx,
        }),
      ]);

      if (!categoriesOwned) {
        throw new Error(
          "Unauthorized: One or more categories do not belong to user",
        );
      }
      if (!viewsOwned) {
        throw new Error(
          "Unauthorized: One or more views do not belong to user",
        );
      }

      const updatedFeeds = await tx
        .update(feeds)
        .set({
          openLocation: input.openLocation,
          name: input.name,
          nameEditedAt: sql`case when ${feeds.name} <> ${input.name} then ${Math.floor(Date.now() / 1000)} else ${feeds.nameEditedAt} end`,
        })
        .where(
          and(eq(feeds.userId, context.user.id), eq(feeds.id, input.feedId)),
        )
        .returning();

      const updatedFeed = updatedFeeds[0];
      if (!updatedFeed) return null;

      // Feed categories - only modify if ownership was verified above
      await tx
        .delete(feedCategories)
        .where(
          and(
            eq(feedCategories.feedId, input.feedId),
            notInArray(feedCategories.categoryId, input.categoryIds),
          ),
        );

      if (input.categoryIds.length > 0) {
        await tx
          .insert(feedCategories)
          .values(
            input.categoryIds.map((categoryId) => ({
              feedId: input.feedId,
              categoryId,
            })),
          )
          .onConflictDoNothing();
      }

      // View feeds - sync direct view assignments
      if (input.viewIds !== undefined) {
        if (input.viewIds.length === 0) {
          await tx.delete(viewFeeds).where(eq(viewFeeds.feedId, input.feedId));
        } else {
          await tx
            .delete(viewFeeds)
            .where(
              and(
                eq(viewFeeds.feedId, input.feedId),
                notInArray(viewFeeds.viewId, input.viewIds),
              ),
            );

          await tx
            .insert(viewFeeds)
            .values(
              input.viewIds.map((viewId) => ({
                viewId,
                feedId: input.feedId,
              })),
            )
            .onConflictDoNothing();
        }
      }

      const [updatedFeedWithOrigins] = await withOrigins(tx, [updatedFeed]);
      return feedsSchema.parse(updatedFeedWithOrigins);
    });
    if (result) {
      await publishReconciliationInvalidation(
        context.user.id,
        organizationInvalidationSummary(),
      );
    }
    return result;
  });

export const bulkDelete = protectedProcedure
  .input(z.object({ feedIds: boundedNumberIdsSchema }))
  .handler(async ({ context, input }) => {
    if (input.feedIds.length === 0) return;

    await context.db.transaction((tx) =>
      deleteUserFeeds(tx, context.user.id, input.feedIds),
    );
    await publishReconciliationInvalidation(
      context.user.id,
      organizationInvalidationSummary(),
    );
  });

export const setActive = protectedProcedure
  .input(z.object({ feedId: z.number(), isActive: z.boolean() }))
  .handler(async ({ context, input }) => {
    // Verify feed belongs to user
    const feed = await context.db.query.feeds.findFirst({
      where: and(eq(feeds.id, input.feedId), eq(feeds.userId, context.user.id)),
    });

    if (!feed) {
      throw new Error("Feed not found");
    }

    // When activating, check feed limits
    if (input.isActive) {
      const canActivate = await canActivateFeed(context.db, context.user.id);
      if (!canActivate) {
        throw new Error(
          "Feed limit reached. Upgrade your plan to activate more feeds.",
        );
      }
    }

    const updatedFeeds = await context.db
      .update(feeds)
      .set({ isActive: input.isActive })
      .where(and(eq(feeds.id, input.feedId), eq(feeds.userId, context.user.id)))
      .returning();

    const updatedFeed = updatedFeeds[0];
    if (!updatedFeed) return null;

    const [updatedFeedWithOrigins] = await withOrigins(context.db, [
      updatedFeed,
    ]);
    const parsed = feedsSchema.parse(updatedFeedWithOrigins);
    await publishReconciliationInvalidation(
      context.user.id,
      organizationInvalidationSummary(),
    );
    return parsed;
  });

export const bulkSetActive = protectedProcedure
  .input(z.object({ feedIds: boundedNumberIdsSchema, isActive: z.boolean() }))
  .handler(async ({ context, input }) => {
    if (input.feedIds.length === 0) return;

    // Resolve the plan limit outside the transaction
    const [planId, isAdmin] = await Promise.all([
      getUserPlanId(context.user.id),
      isAdminUser(context.db, context.user.id),
    ]);
    const planConfig = getEffectivePlanConfig(planId, { isAdmin });

    await context.db.transaction(async (tx) => {
      if (input.isActive) {
        // Count active feeds inside the transaction so the read is
        // consistent with the subsequent update, preventing TOCTOU races.
        const activeCountResult = await tx
          .select({ count: sql<number>`count(*)` })
          .from(feeds)
          .where(
            and(eq(feeds.userId, context.user.id), eq(feeds.isActive, true)),
          )
          .get();
        const activeCount = activeCountResult?.count ?? 0;
        const remainingSlots = Math.max(
          0,
          planConfig.maxActiveFeeds - activeCount,
        );

        // Count how many of the requested feeds are currently inactive
        const currentFeeds = await tx.query.feeds.findMany({
          where: and(
            inArray(feeds.id, input.feedIds),
            eq(feeds.userId, context.user.id),
            eq(feeds.isActive, false),
          ),
          columns: { id: true },
        });

        if (currentFeeds.length > remainingSlots) {
          throw new Error(
            "Feed limit reached. Upgrade your plan to activate more feeds.",
          );
        }
      }

      await tx
        .update(feeds)
        .set({ isActive: input.isActive })
        .where(
          and(
            inArray(feeds.id, input.feedIds),
            eq(feeds.userId, context.user.id),
          ),
        );
    });
    await publishReconciliationInvalidation(
      context.user.id,
      organizationInvalidationSummary(),
    );
  });

export const discoverFeeds = protectedProcedure
  .input(z.object({ url: z.string().trim().min(1).max(DISCOVERY_QUERY_LIMIT) }))
  .handler(({ input, context }) =>
    discoverFeedsForUrl(context.user.id, input.url),
  );

export const revalidate = protectedProcedure
  .input(z.object({ feedId: z.number().int().positive() }))
  .handler(async ({ context, input }) => {
    const lease = captureLimiter.acquire(context.user.id, "revalidation");
    if (!lease.ok)
      throw new Error("Please wait before revalidating a Feed again");
    try {
      const result = await revalidateFeed(
        context.db,
        context.user.id,
        input.feedId,
      );
      await publishReconciliationInvalidation(
        context.user.id,
        organizationInvalidationSummary(),
      );
      return result;
    } finally {
      lease.release();
    }
  });

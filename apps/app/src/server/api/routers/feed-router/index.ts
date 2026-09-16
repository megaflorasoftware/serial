import { discoveredFeedSchema } from "@serial/feed-discovery/schema";
import { DISCOVERY_QUERY_LIMIT } from "@serial/feed-discovery";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  verifyContentCategoriesOwnedByUser,
  verifyViewsOwnedByUser,
} from "./utils";
import { getFeedRssUrl } from "~/lib/feeds/origins";
import {
  findFeedByRssUrl,
  insertFeedWithOrigins,
  loadUserFeedsWithOrigins,
  withOrigins,
} from "~/server/feeds/origins";
import { captureException } from "~/server/logger";
import { parseArrayOfSchema } from "~/lib/schemas/utils";

import { prepareArrayChunks } from "~/lib/iterators";
import { dbSemaphore } from "~/lib/semaphore";
import {
  contentCategories,
  feedCategories,
  feeds,
  feedsSchema,
  openLocationSchema,
  viewFeeds,
  views,
  viewSections,
} from "~/server/db/schema";
import { protectedProcedure } from "~/server/orpc/base";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";
import {
  canActivateFeed,
  getFeedsActivationBudget,
  getUserPlanId,
  isAdminUser,
} from "~/server/subscriptions/helpers";
import { getEffectivePlanConfig } from "~/server/subscriptions/plans";
import { VIEW_LAYOUT_ITEM_TYPE } from "~/server/db/constants";
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
    const { remainingSlots } = await getFeedsActivationBudget(
      context.db,
      context.user.id,
    );

    // Pre-calculate which feeds should be active BEFORE any parallel processing
    const feedsWithActivation = input.feeds.map((feed, index) => ({
      ...feed,
      shouldBeActive: index < remainingSlots,
    }));

    // Process feeds in small batches to avoid overwhelming the database
    const BATCH_SIZE = 4;
    const feedChunks = prepareArrayChunks(feedsWithActivation, BATCH_SIZE);
    const allResults: BulkImportFromFileResult[] = [];
    const userId = context.user.id;

    for (const chunk of feedChunks) {
      const promiseResults = await Promise.allSettled(
        chunk.map(async (feed) => {
          return await dbSemaphore.run(() =>
            context.db.transaction(async (tx) => {
              const newFeedDetails = await fetchNewFeedDetails(feed.feedUrl);
              const newFeed = newFeedDetails[0];
              const newFeedUrl = newFeed ? getFeedRssUrl(newFeed) : "";

              if (!newFeed || !newFeedUrl) {
                return {
                  feedUrl: feed.feedUrl,
                  success: false as const,
                  error: "Unsupported feed URL",
                };
              }

              const existingFeed = await findFeedByRssUrl(tx, {
                feedUrl: newFeedUrl,
                userId,
              });

              if (existingFeed) {
                return {
                  feedUrl: newFeedUrl,
                  success: false as const,
                  error: "Feed already exists",
                };
              }

              const newFeedRow = await insertFeedWithOrigins(tx, {
                userId,
                details: newFeed,
                isActive: feed.shouldBeActive,
              });

              const matchingCategories = await tx
                .select()
                .from(contentCategories)
                .where(
                  and(
                    inArray(contentCategories.name, feed.categories),
                    eq(contentCategories.userId, userId),
                  ),
                )
                .all();
              const matchingCategoryNames = matchingCategories.map(
                (category) => category.name,
              );
              const matchingCategoryNameSet = new Set(matchingCategoryNames);

              const nonMatchingCategories = feed.categories.filter(
                (category) => !matchingCategoryNameSet.has(category),
              );

              const matchingCategoryPromises = matchingCategories.map(
                async (matchingCategory) => {
                  const categoryId = matchingCategory.id;

                  return await tx.insert(feedCategories).values({
                    feedId: newFeedRow.id,
                    categoryId: categoryId,
                  });
                },
              );

              const nonMatchingCategoryPromises = nonMatchingCategories.map(
                async (nonMatchingCategory) => {
                  const newContentCategoryList = await tx
                    .insert(contentCategories)
                    .values({
                      name: nonMatchingCategory,
                      userId,
                    })
                    .returning();
                  const newContentCategory = newContentCategoryList[0];

                  if (!newContentCategory?.id) return;

                  await tx.insert(feedCategories).values({
                    feedId: newFeedRow.id,
                    categoryId: newContentCategory.id,
                  });
                },
              );

              await Promise.allSettled([
                ...matchingCategoryPromises,
                ...nonMatchingCategoryPromises,
              ]);

              return {
                feedUrl: newFeedUrl,
                feedId: newFeedRow.id,
                success: true as const,
              };
            }),
          );
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
    await context.db.transaction(async (tx) => {
      const deletedFeeds = await tx
        .delete(feeds)
        .where(and(eq(feeds.id, input), eq(feeds.userId, context.user.id)))
        .returning({ id: feeds.id });

      if (deletedFeeds.length === 0) return;

      const userViews = await tx
        .select({ id: views.id })
        .from(views)
        .where(eq(views.userId, context.user.id));

      if (userViews.length > 0) {
        await tx.delete(viewSections).where(
          and(
            eq(viewSections.itemType, VIEW_LAYOUT_ITEM_TYPE.FEED),
            eq(viewSections.itemId, input),
            inArray(
              viewSections.viewId,
              userViews.map((view) => view.id),
            ),
          ),
        );
      }
    });
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

    await context.db.transaction(async (tx) => {
      const deletedFeeds = await tx
        .delete(feeds)
        .where(
          and(
            inArray(feeds.id, input.feedIds),
            eq(feeds.userId, context.user.id),
          ),
        )
        .returning({ id: feeds.id });

      if (deletedFeeds.length === 0) return;

      const userViews = await tx
        .select({ id: views.id })
        .from(views)
        .where(eq(views.userId, context.user.id));

      if (userViews.length > 0) {
        await tx.delete(viewSections).where(
          and(
            eq(viewSections.itemType, VIEW_LAYOUT_ITEM_TYPE.FEED),
            inArray(
              viewSections.itemId,
              deletedFeeds.map((feed) => feed.id),
            ),
            inArray(
              viewSections.viewId,
              userViews.map((view) => view.id),
            ),
          ),
        );
      }
    });
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

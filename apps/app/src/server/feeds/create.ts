import type { db as defaultDatabase } from "~/server/db";
import {
  verifyContentCategoriesOwnedByUser,
  verifyViewsOwnedByUser,
} from "~/server/api/routers/feed-router/utils";
import { feedCategories, feedsSchema, viewFeeds } from "~/server/db/schema";
import { parseArrayOfSchema } from "~/lib/schemas/utils";
import {
  findFeedByRssUrl,
  insertFeedWithOrigins,
} from "~/server/feeds/origins";
import { getFeedRssUrl } from "~/lib/feeds/origins";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";
import { getFeedsActivationBudget } from "~/server/subscriptions/helpers";

export async function createFeedsForUser(input: {
  database: typeof defaultDatabase;
  userId: string;
  url: string;
  categoryIds: number[];
  viewIds?: number[];
  returnExisting?: boolean;
}) {
  const newFeedDetails = await fetchNewFeedDetails(input.url);
  if (!newFeedDetails.length) throw new Error("Unsupported feed URL");

  const { remainingSlots, maxActiveFeeds } = await getFeedsActivationBudget(
    input.database,
    input.userId,
  );
  const results = await input.database.transaction(async (transaction) => {
    const [categoriesOwned, viewsOwned] = await Promise.all([
      verifyContentCategoriesOwnedByUser({
        categoryIds: input.categoryIds,
        userId: input.userId,
        db: transaction,
      }),
      verifyViewsOwnedByUser({
        viewIds: input.viewIds ?? [],
        userId: input.userId,
        db: transaction,
      }),
    ]);
    if (!categoriesOwned) {
      throw new Error(
        "Unauthorized: One or more categories do not belong to user",
      );
    }
    if (!viewsOwned) {
      throw new Error("Unauthorized: One or more views do not belong to user");
    }

    return Promise.all(
      newFeedDetails.map(async (newFeed, index) => {
        const feedUrl = getFeedRssUrl(newFeed);
        if (!feedUrl) return { error: "No feed url found." };
        const existingFeed = await findFeedByRssUrl(transaction, {
          feedUrl,
          userId: input.userId,
        });
        if (existingFeed) {
          return input.returnExisting
            ? { feed: existingFeed, created: false as const }
            : { error: "Feed already exists" };
        }

        const insertedFeed = await insertFeedWithOrigins(transaction, {
          userId: input.userId,
          details: newFeed,
          isActive: index < remainingSlots,
        });
        if (input.categoryIds.length > 0) {
          await transaction.insert(feedCategories).values(
            input.categoryIds.map((categoryId) => ({
              feedId: Number(insertedFeed.id),
              categoryId,
            })),
          );
        }
        if (input.viewIds?.length) {
          await transaction.insert(viewFeeds).values(
            input.viewIds.map((viewId) => ({
              viewId,
              feedId: Number(insertedFeed.id),
            })),
          );
        }
        return { feed: insertedFeed, created: true as const };
      }),
    );
  });

  const errors = results.filter(
    (result): result is { error: string } => "error" in result,
  );
  if (errors.length === newFeedDetails.length) {
    throw new Error(errors[0]?.error ?? "Failed to create feed");
  }
  const returnedFeeds = results.flatMap((result) =>
    "feed" in result && result.feed ? [result.feed] : [],
  );
  const createdCount = results.filter(
    (result) => "created" in result && result.created,
  ).length;
  return {
    feeds: parseArrayOfSchema(returnedFeeds, feedsSchema),
    createdCount,
    deactivatedCount: Math.max(0, createdCount - remainingSlots),
    maxActiveFeeds,
  };
}

import { resolveFeedSelection } from "./resolveSelection";
import type { db as defaultDatabase } from "~/server/db";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import {
  verifyContentCategoriesOwnedByUser,
  verifyViewsOwnedByUser,
} from "~/server/api/routers/feed-router/utils";
import { feedCategories, feedsSchema, viewFeeds } from "~/server/db/schema";
import { parseArrayOfSchema } from "~/lib/schemas/utils";
import { createOrReuseFeed } from "~/server/feeds/origins";
import { getFeedsActivationBudget } from "~/server/subscriptions/helpers";

export async function createFeedsForUser(input: {
  database: typeof defaultDatabase;
  userId: string;
  url: string;
  selection?: DiscoveredFeed;
  categoryIds: number[];
  viewIds?: number[];
  returnExisting?: boolean;
}) {
  const newFeedDetails = await resolveFeedSelection(
    input.userId,
    input.url,
    input.selection,
  );
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

    let newFeedCount = 0;
    const results = [];
    for (const newFeed of newFeedDetails) {
      // Each lookup must see earlier inserts, and reused Feeds must not consume slots.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await createOrReuseFeed(transaction, {
        userId: input.userId,
        details: newFeed,
        isActive: newFeedCount < remainingSlots,
      });
      if (!result.created) {
        results.push(
          result.attached || input.returnExisting
            ? result
            : { error: "Feed already exists" },
        );
        continue;
      }
      const insertedFeed = result.feed;
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
      newFeedCount++;
      results.push({ feed: insertedFeed, created: true as const });
    }
    return results;
  });

  const errors = results.filter(
    (result): result is { error: string } => "error" in result,
  );
  if (errors.length === newFeedDetails.length) {
    throw new Error(errors[0]?.error ?? "Failed to create feed");
  }
  const returnedFeeds = results.flatMap((result) =>
    "feed" in result ? [result.feed] : [],
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

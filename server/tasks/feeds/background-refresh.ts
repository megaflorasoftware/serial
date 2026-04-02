import { defineTask } from "nitro/task";
import { and, eq, lte } from "drizzle-orm";
import { db } from "~/server/db";
import { feeds } from "~/server/db/schema";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { getUserPlanId } from "~/server/subscriptions/helpers";
import { getEffectivePlanConfig } from "~/server/subscriptions/plans";
import { IS_BILLING_ENABLED } from "~/server/subscriptions/polar";

export default defineTask({
  meta: {
    name: "feeds:background-refresh",
    description: "Background refresh of active feeds for paid users",
  },
  async run() {
    const backgroundRefreshEnabled =
      process.env.BACKGROUND_REFRESH_ENABLED !== "false";

    if (!backgroundRefreshEnabled) {
      return { result: "disabled" };
    }

    const now = new Date();

    // Find distinct userIds with active feeds that need refreshing
    const usersWithFeeds = await db
      .selectDistinct({ userId: feeds.userId })
      .from(feeds)
      .where(and(eq(feeds.isActive, true), lte(feeds.nextFetchAt, now)))
      .all();

    if (usersWithFeeds.length === 0) {
      return { result: "no-feeds-to-refresh" };
    }

    // Pre-fetch plan IDs for all users to avoid N+1 Polar API calls
    const userPlanIds = new Map<
      string,
      Awaited<ReturnType<typeof getUserPlanId>>
    >();
    if (IS_BILLING_ENABLED) {
      await Promise.all(
        usersWithFeeds.map(async ({ userId }) => {
          const planId = await getUserPlanId(userId);
          userPlanIds.set(userId, planId);
        }),
      );
    }

    let refreshedCount = 0;

    for (const { userId } of usersWithFeeds) {
      try {
        // For main instance, only refresh for paid users
        if (IS_BILLING_ENABLED) {
          const planId = userPlanIds.get(userId) ?? "free";
          const config = getEffectivePlanConfig(planId);
          if (!config.backgroundRefreshIntervalMs) {
            continue; // Free plan, no background refresh
          }
        }

        // Get active feeds that need refreshing for this user
        const userFeeds = await db
          .select()
          .from(feeds)
          .where(
            and(
              eq(feeds.userId, userId),
              eq(feeds.isActive, true),
              lte(feeds.nextFetchAt, now),
            ),
          )
          .all();

        if (userFeeds.length === 0) continue;

        // Fetch and insert feed data
        for await (const result of fetchAndInsertFeedData({ db }, userFeeds)) {
          if (result.status === "success") {
            refreshedCount++;
          }
        }
      } catch (e) {
        console.error(
          `[background-refresh] Failed to refresh feeds for user ${userId}:`,
          e,
        );
      }
    }

    return { result: `refreshed ${refreshedCount} feeds` };
  },
});

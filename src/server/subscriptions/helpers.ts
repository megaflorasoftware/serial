import { and, count, desc, eq } from "drizzle-orm";
import { determinePlanFromProductId, getEffectivePlanConfig } from "./plans";
import { polarClient } from "./polar";
import type { PlanId } from "./plans";
import type { db as Database } from "~/server/db";
import { IS_MAIN_INSTANCE } from "~/lib/constants";
import { feeds } from "~/server/db/schema";

type DB = typeof Database;

export async function getActiveFeedCount(db: DB, userId: string) {
  const result = await db
    .select({ count: count() })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.isActive, true)))
    .get();
  return result?.count ?? 0;
}

export async function getUserPlanId(userId: string): Promise<PlanId> {
  if (!IS_MAIN_INSTANCE || !polarClient) return "pro";

  try {
    // Look up active subscriptions by externalCustomerId (Better Auth sets this to user ID)
    const subscriptions = await polarClient.subscriptions.list({
      externalCustomerId: [userId],
      active: true,
    });

    const activeSub = subscriptions.result?.items?.[0];
    if (!activeSub?.productId) return "free";

    const plan = determinePlanFromProductId(activeSub.productId);
    return plan ?? "free";
  } catch {
    return "free";
  }
}

export async function canActivateFeed(db: DB, userId: string) {
  const planId = await getUserPlanId(userId);
  const config = getEffectivePlanConfig(planId);
  const activeCount = await getActiveFeedCount(db, userId);
  return activeCount < config.maxActiveFeeds;
}

export async function getUserPlanLimits(db: DB, userId: string) {
  const planId = await getUserPlanId(userId);
  const config = getEffectivePlanConfig(planId);
  const activeFeeds = await getActiveFeedCount(db, userId);

  return {
    planId: config.id,
    planName: config.name,
    maxActiveFeeds:
      config.maxActiveFeeds === Infinity ? -1 : config.maxActiveFeeds,
    activeFeeds,
    backgroundRefreshIntervalMs: config.backgroundRefreshIntervalMs,
  };
}

export async function deactivateExcessFeeds(
  db: DB,
  userId: string,
  maxActive: number,
) {
  const activeFeeds = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.isActive, true)))
    .orderBy(desc(feeds.lastFetchedAt))
    .all();

  if (activeFeeds.length <= maxActive) return;

  const feedsToDeactivate = activeFeeds.slice(maxActive);
  const idsToDeactivate = feedsToDeactivate.map((f) => f.id);

  for (const feedId of idsToDeactivate) {
    await db.update(feeds).set({ isActive: false }).where(eq(feeds.id, feedId));
  }
}

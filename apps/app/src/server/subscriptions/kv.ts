import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { determinePlanFromProductId, polarClient } from "./polar";
import { getEffectivePlanConfig, PLANS } from "./plans";
import { deactivateExcessFeeds, isAdminUser } from "./helpers";
import type { PlanId } from "./plans";
import type { db as Database } from "~/server/db";
import { feedOrigins, feeds, user } from "~/server/db/schema";
import { getKV } from "~/server/kv";
import { logError, logWarning } from "~/server/logger";

type DB = typeof Database;

export const redis = await getKV();

// ---------------------------------------------------------------------------
// Cached subscription type — stored as JSON at `polar:sub:{userId}`
// ---------------------------------------------------------------------------

export type PolarSubscriptionCache = {
  planId: PlanId;
  status: string; // "active" | "trialing" | "past_due" | "canceled" | "none"
  subscriptionId: string | null;
  productId: string | null;
  recurringInterval: string | null; // "month" | "year"
  currentPeriodStart: string | null; // ISO string
  currentPeriodEnd: string | null; // ISO string
  cancelAtPeriodEnd: boolean;
  amount: number | null; // cents
  currency: string | null;
  syncedAt: string; // ISO timestamp of last sync
};

function kvKey(userId: string) {
  return `polar:sub:${userId}`;
}

// ---------------------------------------------------------------------------
// syncPolarDataToKV — the single source-of-truth sync function.
// Fetches the latest subscription state from Polar and writes it to KV.
// No TTL: we keep the data indefinitely so we never need to hit Polar on reads.
// ---------------------------------------------------------------------------

export async function syncPolarDataToKV(
  userId: string,
): Promise<PolarSubscriptionCache> {
  if (!polarClient) {
    throw new Error(
      "[kv] syncPolarDataToKV called but Polar client is not available",
    );
  }

  try {
    const subscriptions = await polarClient.subscriptions.list({
      externalCustomerId: [userId],
      active: true,
    });

    const activeSub = subscriptions.result?.items?.[0];

    let data: PolarSubscriptionCache;

    if (activeSub?.productId) {
      const planId = determinePlanFromProductId(activeSub.productId) ?? "free";

      data = {
        planId,
        status: activeSub.status ?? "active",
        subscriptionId: activeSub.id ?? null,
        productId: activeSub.productId,
        recurringInterval: activeSub.recurringInterval ?? null,
        currentPeriodStart: activeSub.currentPeriodStart
          ? new Date(activeSub.currentPeriodStart).toISOString()
          : null,
        currentPeriodEnd: activeSub.currentPeriodEnd
          ? new Date(activeSub.currentPeriodEnd).toISOString()
          : null,
        cancelAtPeriodEnd: activeSub.cancelAtPeriodEnd ?? false,
        amount: activeSub.amount ?? null,
        currency: activeSub.currency ?? null,
        syncedAt: new Date().toISOString(),
      };
    } else {
      data = {
        planId: "free",
        status: "none",
        subscriptionId: null,
        productId: null,
        recurringInterval: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        amount: null,
        currency: null,
        syncedAt: new Date().toISOString(),
      };
    }

    // Write to KV (best-effort — failure here is non-fatal)
    if (redis) {
      try {
        await redis.set(kvKey(userId), JSON.stringify(data));
      } catch (e) {
        logWarning(
          `[kv] Failed to write subscription cache for user ${userId}:`,
          e,
        );
      }
    }

    return data;
  } catch (e) {
    // Polar API failed — try to return cached data from KV
    if (redis) {
      try {
        const cached = await getSubscriptionFromKV(userId);
        if (cached) {
          logWarning(
            `[kv] Polar API failed for user ${userId}, using cached data:`,
            e,
          );
          return cached;
        }
      } catch {
        // KV also failed, fall through
      }
    }

    logError(
      `[kv] syncPolarDataToKV failed for user ${userId} (no cached fallback):`,
      e,
    );
    throw e;
  }
}

// ---------------------------------------------------------------------------
// getSubscriptionFromKV — read-only KV lookup.
// Returns null on miss, null redis, or any error.
// ---------------------------------------------------------------------------

export async function getSubscriptionFromKV(
  userId: string,
): Promise<PolarSubscriptionCache | null> {
  if (!redis) return null;

  try {
    const raw = await redis.get(kvKey(userId));
    if (!raw) return null;

    return JSON.parse(raw) as PolarSubscriptionCache;
  } catch (e) {
    logWarning(`[kv] Failed to read subscription cache for user ${userId}:`, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// applySubscriptionSideEffects — business logic that runs after a sync.
// Extracted from the old webhook handlers.
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export async function applySubscriptionSideEffects(
  db: DB,
  userId: string,
  data: PolarSubscriptionCache,
): Promise<void> {
  const isAdmin = await isAdminUser(db, userId);
  const config = getEffectivePlanConfig(data.planId, { isAdmin });

  // Clear the user's manual-refresh cooldown so they can immediately
  // refresh with their new plan's interval after upgrading.
  await db.update(user).set({ nextRefreshAt: null }).where(eq(user.id, userId));

  if (ACTIVE_STATUSES.has(data.status)) {
    // Subscription is active — stagger origin nextFetchAt across the refresh
    // interval so origins don't all become due at the same instant.
    if (config.backgroundRefreshIntervalMs) {
      const activeOrigins = await db
        .select({ id: feedOrigins.id })
        .from(feedOrigins)
        .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
        .where(and(eq(feedOrigins.userId, userId), eq(feeds.isActive, true)))
        .orderBy(asc(feedOrigins.id))
        .all();

      const interval = config.backgroundRefreshIntervalMs;
      const originCount = activeOrigins.length;

      if (originCount > 0) {
        const nowMs = Date.now();
        const cases = activeOrigins.map((origin, i) => {
          const offset =
            originCount > 1 ? Math.round((interval / originCount) * i) : 0;
          const ts = Math.floor((nowMs + offset) / 1000);
          return sql`WHEN ${origin.id} THEN ${ts}`;
        });

        await db
          .update(feedOrigins)
          .set({
            nextFetchAt: sql`(CASE ${feedOrigins.id} ${sql.join(cases, sql` `)} END)`,
          })
          .where(
            inArray(
              feedOrigins.id,
              activeOrigins.map((origin) => origin.id),
            ),
          );
      }
    }
  } else {
    // Subscription ended — deactivate excess feeds, clear nextFetchAt
    await deactivateExcessFeeds(db, userId, PLANS.free.maxActiveFeeds);
    await db
      .update(feedOrigins)
      .set({ nextFetchAt: null })
      .where(eq(feedOrigins.userId, userId));
  }
}

import { z } from "zod";
import { eq } from "drizzle-orm";
import type { PlanId } from "~/server/subscriptions/plans";
import { protectedProcedure } from "~/server/orpc/base";
import {
  getUserPlanId,
  getUserPlanLimits,
} from "~/server/subscriptions/helpers";
import { IS_BILLING_ENABLED, polarClient } from "~/server/subscriptions/polar";
import {
  determinePlanFromProductId,
  getAllKnownProductIds,
  PLANS,
} from "~/server/subscriptions/plans";
import {
  applySubscriptionSideEffects,
  syncPolarDataToKV,
} from "~/server/subscriptions/kv";
import { user } from "~/server/db/schema";
import { IS_EMAIL_ENABLED } from "~/server/email";

const BASE_URL = process.env.BETTER_AUTH_BASE_URL ?? "http://localhost:3000";

function getValidatedOrigin(headers: Headers): string {
  const origin = headers.get("origin") ?? headers.get("referer");
  if (origin) {
    try {
      const parsed = new URL(origin);
      const base = new URL(BASE_URL);
      if (parsed.origin === base.origin) {
        return base.origin;
      }
    } catch {
      // invalid URL, fall through
    }
  }
  return BASE_URL;
}

type CachedProducts = {
  data: PlanProduct[];
  expiresAt: number;
};

type PlanProduct = {
  planId: PlanId;
  planName: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  monthlyProductId: string | null;
  annualProductId: string | null;
};

let productsCache: CachedProducts | null = null;
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

export const getStatus = protectedProcedure.handler(async ({ context }) => {
  return getUserPlanLimits(context.db, context.user.id);
});

/** Force-refresh the plan from Polar, bypassing the KV cache. */
export const refreshStatus = protectedProcedure.handler(async ({ context }) => {
  if (IS_BILLING_ENABLED) {
    try {
      await syncPolarDataToKV(context.user.id);
    } catch (e) {
      console.warn(
        `[subscription] refreshStatus sync failed for user ${context.user.id}:`,
        e,
      );
    }
  }
  return getUserPlanLimits(context.db, context.user.id);
});

export const getProducts = protectedProcedure.handler(async () => {
  if (!IS_BILLING_ENABLED || !polarClient) {
    return [];
  }

  // Check cache
  if (productsCache && Date.now() < productsCache.expiresAt) {
    return productsCache.data;
  }

  const productIds = [
    PLANS["standard-small"].polarMonthlyProductId,
    PLANS["standard-small"].polarAnnualProductId,
    PLANS["standard-medium"].polarMonthlyProductId,
    PLANS["standard-medium"].polarAnnualProductId,
    PLANS["standard-large"].polarMonthlyProductId,
    PLANS["standard-large"].polarAnnualProductId,
    PLANS.pro.polarMonthlyProductId,
    PLANS.pro.polarAnnualProductId,
  ].filter(Boolean);

  if (productIds.length === 0) {
    return [];
  }

  try {
    const results: PlanProduct[] = [];

    for (const planId of [
      "standard-small",
      "standard-medium",
      "standard-large",
      "pro",
    ] as const) {
      const plan = PLANS[planId];

      // Skip plans that have no Polar product IDs configured
      if (!plan.polarMonthlyProductId && !plan.polarAnnualProductId) continue;

      let monthlyPrice: number | null = null;
      let annualPrice: number | null = null;

      if (plan.polarMonthlyProductId) {
        try {
          const product = await polarClient.products.get({
            id: plan.polarMonthlyProductId,
          });
          const price = product.prices?.[0];
          if (price && "amountType" in price && price.amountType === "fixed") {
            monthlyPrice = (price as { priceAmount: number }).priceAmount;
          }
        } catch {
          // Skip if product not found
        }
      }

      if (plan.polarAnnualProductId) {
        try {
          const product = await polarClient.products.get({
            id: plan.polarAnnualProductId,
          });
          const price = product.prices?.[0];
          if (price && "amountType" in price && price.amountType === "fixed") {
            annualPrice = (price as { priceAmount: number }).priceAmount;
          }
        } catch (e) {
          console.error(
            `[subscription] Failed to fetch annual product for ${planId}:`,
            e,
          );
        }
      }

      results.push({
        planId,
        planName: plan.name,
        monthlyPrice,
        annualPrice,
        monthlyProductId: plan.polarMonthlyProductId,
        annualProductId: plan.polarAnnualProductId,
      });
    }

    productsCache = {
      data: results,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    return results;
  } catch (e) {
    console.error("[subscription] Failed to fetch products:", e);
    return [];
  }
});

export const createCheckout = protectedProcedure
  .input(
    z.object({
      planId: z.enum([
        "standard-small",
        "standard-medium",
        "standard-large",
        "pro",
      ]),
      returnPath: z.string().optional(),
    }),
  )
  .handler(async ({ context, input }) => {
    if (!IS_BILLING_ENABLED || !polarClient) {
      return { url: null, error: null };
    }

    // Prevent double-checkout: block if user already has an active paid plan
    const existingPlan = await getUserPlanId(context.user.id);
    if (existingPlan !== "free") {
      return { url: null, error: "already-subscribed" as const };
    }

    if (IS_EMAIL_ENABLED) {
      const currentUser = await context.db
        .select({ emailVerified: user.emailVerified })
        .from(user)
        .where(eq(user.id, context.user.id))
        .get();

      if (!currentUser?.emailVerified) {
        return { url: null, error: "email-not-verified" as const };
      }
    }

    const plan = PLANS[input.planId];
    const productIds = [
      plan.polarMonthlyProductId,
      plan.polarAnnualProductId,
    ].filter((id): id is string => id != null);

    if (productIds.length === 0) {
      return { url: null, error: null };
    }

    const origin = getValidatedOrigin(context.headers);
    // Validate returnPath: resolve against origin and verify it stays on the same host.
    // This prevents open-redirect via protocol-relative paths (//evil.com) or traversal (/../).
    let safePath = "/";
    if (input.returnPath) {
      try {
        const resolved = new URL(input.returnPath, origin);
        if (resolved.origin === origin) {
          safePath = resolved.pathname;
        }
      } catch {
        // Malformed path, fall back to "/"
      }
    }
    const checkout = await polarClient.checkouts.create({
      externalCustomerId: context.user.id,
      customerEmail: context.user.email,
      products: productIds,
      successUrl: `${origin}${safePath}?checkout_success=true`,
      returnUrl: `${origin}${safePath}`,
    });

    return { url: checkout.url, error: null };
  });

export const previewPlanSwitch = protectedProcedure
  .input(
    z.object({
      planId: z.enum([
        "standard-small",
        "standard-medium",
        "standard-large",
        "pro",
      ]),
    }),
  )
  .handler(async ({ context, input }) => {
    if (!IS_BILLING_ENABLED || !polarClient) {
      return null;
    }

    // Find current active subscription
    const subscriptions = await polarClient.subscriptions.list({
      externalCustomerId: [context.user.id],
      active: true,
    });

    const currentSub = subscriptions.result?.items?.[0];
    if (!currentSub) return null;

    const currentPlanId = determinePlanFromProductId(currentSub.productId);
    if (!currentPlanId || currentPlanId === input.planId) return null;

    const newPlan = PLANS[input.planId];
    const isMonthly = currentSub.recurringInterval === "month";
    const newProductId = isMonthly
      ? newPlan.polarMonthlyProductId
      : newPlan.polarAnnualProductId;

    if (!newProductId) return null;

    // Get the new product price
    let newAmount: number | null = null;
    try {
      const product = await polarClient.products.get({ id: newProductId });
      const price = product.prices?.[0];
      if (price && "amountType" in price && price.amountType === "fixed") {
        newAmount = (price as { priceAmount: number }).priceAmount;
      }
    } catch {
      return null;
    }

    // Calculate proration
    const now = Date.now();
    const periodStart = new Date(currentSub.currentPeriodStart).getTime();
    const periodEnd = new Date(currentSub.currentPeriodEnd).getTime();
    const totalPeriod = periodEnd - periodStart;
    const elapsed = now - periodStart;
    const remaining = Math.max(0, 1 - elapsed / totalPeriod);

    const currentCredit = Math.round(currentSub.amount * remaining);
    const newCharge = Math.round((newAmount ?? 0) * remaining);
    const proratedAmount = Math.max(0, newCharge - currentCredit);

    return {
      currentPlanId,
      currentPlanName: PLANS[currentPlanId].name,
      currentAmount: currentSub.amount,
      newPlanId: input.planId,
      newPlanName: newPlan.name,
      newAmount: newAmount ?? 0,
      proratedAmount,
      currency: currentSub.currency,
      billingInterval: currentSub.recurringInterval as "month" | "year",
      subscriptionId: currentSub.id,
      newProductId,
    };
  });

export const switchPlan = protectedProcedure
  .input(
    z.object({
      subscriptionId: z.string(),
      newProductId: z.string(),
    }),
  )
  .handler(async ({ context, input }) => {
    if (!IS_BILLING_ENABLED || !polarClient) {
      return { success: false };
    }

    // Verify the new product ID belongs to a known plan
    const knownProductIds = getAllKnownProductIds();
    if (!knownProductIds.has(input.newProductId)) {
      throw new Error("Invalid product ID");
    }

    // Verify the subscription belongs to this user
    const subscriptions = await polarClient.subscriptions.list({
      externalCustomerId: [context.user.id],
      active: true,
    });

    const sub = subscriptions.result?.items?.find(
      (s) => s.id === input.subscriptionId,
    );
    if (!sub) {
      throw new Error("Subscription not found");
    }

    await polarClient.subscriptions.update({
      id: input.subscriptionId,
      subscriptionUpdate: {
        productId: input.newProductId,
        prorationBehavior: "prorate",
      },
    });

    console.log(
      `[polar] Plan switched for user=${context.user.id} subscription=${input.subscriptionId} newProduct=${input.newProductId}`,
    );

    // Immediately update KV cache with the new plan
    try {
      await syncPolarDataToKV(context.user.id);
    } catch (e) {
      console.warn(
        `[polar] Post-switch sync failed for user=${context.user.id}:`,
        e,
      );
    }

    return { success: true };
  });

/**
 * Eagerly sync subscription state after checkout completes.
 * Called once from the client on checkout success — replaces the old polling approach.
 */
export const syncAfterCheckout = protectedProcedure.handler(
  async ({ context }) => {
    if (!IS_BILLING_ENABLED) {
      return getUserPlanLimits(context.db, context.user.id);
    }

    try {
      const data = await syncPolarDataToKV(context.user.id);
      await applySubscriptionSideEffects(context.db, context.user.id, data);
    } catch (e) {
      console.warn(
        `[subscription] syncAfterCheckout failed for user ${context.user.id}:`,
        e,
      );
    }

    return getUserPlanLimits(context.db, context.user.id);
  },
);

export const createPortalSession = protectedProcedure.handler(
  async ({ context }) => {
    if (!IS_BILLING_ENABLED || !polarClient) {
      return { url: null };
    }

    const origin = getValidatedOrigin(context.headers);
    const session = await polarClient.customerSessions.create({
      externalCustomerId: context.user.id,
      returnUrl: `${origin}/`,
    });

    return { url: session.customerPortalUrl };
  },
);

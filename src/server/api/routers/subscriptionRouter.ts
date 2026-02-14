import { Polar } from "@polar-sh/sdk";
import type { PlanId } from "~/server/subscriptions/plans";
import { IS_MAIN_INSTANCE } from "~/lib/constants";
import { protectedProcedure } from "~/server/orpc/base";
import { getUserPlanLimits } from "~/server/subscriptions/helpers";
import { PLANS } from "~/server/subscriptions/plans";

const polarClient =
  IS_MAIN_INSTANCE && process.env.POLAR_ACCESS_TOKEN
    ? new Polar({
        accessToken: process.env.POLAR_ACCESS_TOKEN,
        server:
          process.env.NODE_ENV === "production" ? "production" : "sandbox",
      })
    : null;

type CachedProducts = {
  data: PlanProduct[];
  expiresAt: number;
};

type PlanProduct = {
  planId: PlanId;
  planName: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
};

let productsCache: CachedProducts | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const getStatus = protectedProcedure.handler(async ({ context }) => {
  return getUserPlanLimits(context.db, context.user.id);
});

export const getProducts = protectedProcedure.handler(async () => {
  if (!IS_MAIN_INSTANCE || !polarClient) {
    return [];
  }

  // Check cache
  if (productsCache && Date.now() < productsCache.expiresAt) {
    return productsCache.data;
  }

  const productIds = [
    PLANS.standard.polarMonthlyProductId,
    PLANS.standard.polarAnnualProductId,
    PLANS.pro.polarMonthlyProductId,
    PLANS.pro.polarAnnualProductId,
  ].filter(Boolean);

  if (productIds.length === 0) {
    return [];
  }

  try {
    const results: PlanProduct[] = [];

    for (const planId of ["standard", "pro"] as const) {
      const plan = PLANS[planId];
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
        } catch {
          // Skip if product not found
        }
      }

      results.push({
        planId,
        planName: plan.name,
        monthlyPrice,
        annualPrice,
      });
    }

    productsCache = {
      data: results,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    return results;
  } catch {
    return [];
  }
});

import { IS_BILLING_ENABLED } from "./polar";

export const PLAN_IDS = ["free", "standard", "daily"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type PlanConfig = {
  id: PlanId;
  name: string;
  maxActiveFeeds: number;
  backgroundRefreshIntervalMs: number | null;
  polarMonthlyProductId: string | null;
  polarAnnualProductId: string | null;
};

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    maxActiveFeeds: 40,
    backgroundRefreshIntervalMs: null,
    polarMonthlyProductId: null,
    polarAnnualProductId: null,
  },
  standard: {
    id: "standard",
    name: "Standard",
    maxActiveFeeds: 400,
    backgroundRefreshIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
    polarMonthlyProductId:
      process.env.POLAR_STANDARD_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId: process.env.POLAR_STANDARD_ANNUAL_PRODUCT_ID ?? null,
  },
  daily: {
    id: "daily",
    name: "Daily",
    maxActiveFeeds: 1000,
    backgroundRefreshIntervalMs: 15 * 60 * 1000, // 15 minutes
    polarMonthlyProductId: process.env.POLAR_DAILY_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId: process.env.POLAR_DAILY_ANNUAL_PRODUCT_ID ?? null,
  },
};

const UNLIMITED_CONFIG: PlanConfig = {
  id: "daily",
  name: "Daily",
  maxActiveFeeds: Infinity,
  backgroundRefreshIntervalMs: 5 * 60 * 1000,
  polarMonthlyProductId: null,
  polarAnnualProductId: null,
};

export function getEffectivePlanConfig(planId: PlanId): PlanConfig {
  if (!IS_BILLING_ENABLED) return UNLIMITED_CONFIG;
  return PLANS[planId];
}

export function determinePlanFromProductId(productId: string): PlanId | null {
  for (const plan of Object.values(PLANS)) {
    if (
      plan.polarMonthlyProductId === productId ||
      plan.polarAnnualProductId === productId
    ) {
      return plan.id;
    }
  }
  return null;
}

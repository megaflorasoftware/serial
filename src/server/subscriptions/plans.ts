import { IS_BILLING_ENABLED } from "./polar";

export const PLAN_IDS = ["free", "standard", "daily", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type PlanConfig = {
  id: PlanId;
  name: string;
  maxActiveFeeds: number;
  /** Minimum interval between user-initiated refreshes (server-enforced). */
  refreshIntervalMs: number;
  backgroundRefreshIntervalMs: number | null;
  polarMonthlyProductId: string | null;
  polarAnnualProductId: string | null;
};

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    maxActiveFeeds: 40,
    refreshIntervalMs: 60 * 60 * 1000 - 15_000, // 1 hour
    backgroundRefreshIntervalMs: null,
    polarMonthlyProductId: null,
    polarAnnualProductId: null,
  },
  standard: {
    id: "standard",
    name: "Standard",
    maxActiveFeeds: 200,
    refreshIntervalMs: 15 * 60 * 1000 - 15_000, // 15 minutes
    backgroundRefreshIntervalMs: 4 * 60 * 60 * 1000, // 4 hours
    polarMonthlyProductId:
      process.env.POLAR_STANDARD_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId: process.env.POLAR_STANDARD_ANNUAL_PRODUCT_ID ?? null,
  },
  daily: {
    id: "daily",
    name: "Daily",
    maxActiveFeeds: 500,
    refreshIntervalMs: 5 * 60 * 1000 - 15_000, // 5 minutes
    backgroundRefreshIntervalMs: 15 * 60 * 1000, // 15 minutes
    polarMonthlyProductId: process.env.POLAR_DAILY_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId: process.env.POLAR_DAILY_ANNUAL_PRODUCT_ID ?? null,
  },
  pro: {
    id: "pro",
    name: "Pro",
    maxActiveFeeds: 1000,
    refreshIntervalMs: 1 * 60 * 1000 - 15_000, // 1 minute
    backgroundRefreshIntervalMs: 1 * 60 * 1000, // 1 minute
    polarMonthlyProductId: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId:
      process.env.POLAR_STANDARD_LARGE_QUOTA_ANNUAL_PRODUCT_ID ?? null,
  },
};

const UNLIMITED_CONFIG: PlanConfig = {
  id: "pro",
  name: "Pro",
  maxActiveFeeds: Infinity,
  refreshIntervalMs: 1 * 60 * 1000 - 15_000,
  backgroundRefreshIntervalMs: 1 * 60 * 1000,
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

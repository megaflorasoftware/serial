import { IS_BILLING_ENABLED } from "./polar";

export const PLAN_IDS = [
  "free",
  "standard-small",
  "standard-medium",
  "standard-large",
  "pro",
] as const;
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

/**
 * Small buffer subtracted from refresh intervals so users don't hit the
 * rate-limit boundary when refreshing right on the dot (e.g. every 15 min).
 */
const REFRESH_PERIOD_BUFFER = 15_000;

const STANDARD_REFRESH_MS = 15 * 60 * 1000 - REFRESH_PERIOD_BUFFER; // ~15 minutes
const STANDARD_BACKGROUND_REFRESH_MS = 4 * 60 * 60 * 1000; // 4 hours
const PRO_REFRESH_MS = 1 * 60 * 1000 - REFRESH_PERIOD_BUFFER; // ~1 minute
const PRO_BACKGROUND_REFRESH_MS = 1 * 60 * 1000; // 1 minute

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    maxActiveFeeds: 40,
    refreshIntervalMs: 60 * 60 * 1000 - REFRESH_PERIOD_BUFFER, // ~1 hour
    backgroundRefreshIntervalMs: null,
    polarMonthlyProductId: null,
    polarAnnualProductId: null,
  },
  "standard-small": {
    id: "standard-small",
    name: "Small",
    maxActiveFeeds: 200,
    refreshIntervalMs: STANDARD_REFRESH_MS,
    backgroundRefreshIntervalMs: STANDARD_BACKGROUND_REFRESH_MS,
    polarMonthlyProductId:
      process.env.POLAR_STANDARD_SMALL_QUOTA_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId:
      process.env.POLAR_STANDARD_SMALL_QUOTA_ANNUAL_PRODUCT_ID ?? null,
  },
  "standard-medium": {
    id: "standard-medium",
    name: "Medium",
    maxActiveFeeds: 500,
    refreshIntervalMs: STANDARD_REFRESH_MS,
    backgroundRefreshIntervalMs: STANDARD_BACKGROUND_REFRESH_MS,
    polarMonthlyProductId:
      process.env.POLAR_STANDARD_MEDIUM_QUOTA_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId:
      process.env.POLAR_STANDARD_MEDIUM_QUOTA_ANNUAL_PRODUCT_ID ?? null,
  },
  "standard-large": {
    id: "standard-large",
    name: "Large",
    maxActiveFeeds: 1000,
    refreshIntervalMs: STANDARD_REFRESH_MS,
    backgroundRefreshIntervalMs: STANDARD_BACKGROUND_REFRESH_MS,
    polarMonthlyProductId:
      process.env.POLAR_STANDARD_LARGE_QUOTA_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId:
      process.env.POLAR_STANDARD_LARGE_QUOTA_ANNUAL_PRODUCT_ID ?? null,
  },
  pro: {
    id: "pro",
    name: "Pro",
    maxActiveFeeds: 2500,
    refreshIntervalMs: PRO_REFRESH_MS,
    backgroundRefreshIntervalMs: PRO_BACKGROUND_REFRESH_MS,
    polarMonthlyProductId: process.env.POLAR_PRO_MONTHLY_PRODUCT_ID ?? null,
    polarAnnualProductId: process.env.POLAR_PRO_ANNUAL_PRODUCT_ID ?? null,
  },
};

const UNLIMITED_CONFIG: PlanConfig = {
  id: "pro",
  name: "Pro",
  maxActiveFeeds: Infinity,
  refreshIntervalMs: PRO_REFRESH_MS,
  backgroundRefreshIntervalMs: PRO_BACKGROUND_REFRESH_MS,
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

/** Returns the set of all configured Polar product IDs across every plan. */
export function getAllKnownProductIds(): Set<string> {
  const ids = new Set<string>();
  for (const plan of Object.values(PLANS)) {
    if (plan.polarMonthlyProductId) ids.add(plan.polarMonthlyProductId);
    if (plan.polarAnnualProductId) ids.add(plan.polarAnnualProductId);
  }
  return ids;
}

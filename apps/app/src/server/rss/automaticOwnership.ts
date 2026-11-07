import type { AutomaticRssOwner } from "~/lib/reconciliation";
import type { db as Database } from "~/server/db";
import type { PlanId } from "~/server/subscriptions/plans";
import { env } from "~/env";
import { getEffectivePlanConfig } from "~/server/subscriptions/plans";

export function automaticRssOwnerFor(input: {
  backgroundRefreshEnabled: boolean;
  backgroundRefreshIntervalMs: number | null;
}): AutomaticRssOwner {
  return input.backgroundRefreshEnabled &&
    input.backgroundRefreshIntervalMs !== null
    ? "background-task"
    : "client";
}

export function automaticRssOwnerForPlan(input: {
  backgroundRefreshEnabled: boolean;
  planId: PlanId;
  isAdmin?: boolean;
}) {
  const plan = getEffectivePlanConfig(input.planId, {
    isAdmin: input.isAdmin,
  });
  return automaticRssOwnerFor({
    backgroundRefreshEnabled: input.backgroundRefreshEnabled,
    backgroundRefreshIntervalMs: plan.backgroundRefreshIntervalMs,
  });
}

export async function resolveAutomaticRssOwner(input: {
  database: typeof Database;
  userId: string;
}) {
  const { getUserPlanLimits } = await import("~/server/subscriptions/helpers");
  const limits = await getUserPlanLimits(input.database, input.userId);
  return automaticRssOwnerFor({
    backgroundRefreshEnabled: env.BACKGROUND_REFRESH_ENABLED,
    backgroundRefreshIntervalMs: limits.backgroundRefreshIntervalMs,
  });
}

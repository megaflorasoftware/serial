import { automaticRssOwnerFor } from "../rss/automaticOwnership";
import type { PlanConfig } from "../subscriptions/plans";
import type { user } from "../db/schema";

export const FREE_ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export function canApplyStream(input: {
  account: Pick<
    typeof user.$inferSelect,
    "banned" | "banExpires" | "lastActiveAt"
  >;
  activeFeed: boolean;
  plan: PlanConfig;
  backgroundEnabled: boolean;
  now: Date;
  manual?: boolean;
}) {
  const { account, plan, now } = input;
  if (
    !input.activeFeed ||
    (account.banned && (!account.banExpires || account.banExpires > now))
  )
    return false;
  if (input.manual) return true;
  if (!input.backgroundEnabled) return false;
  if (
    automaticRssOwnerFor({
      backgroundRefreshEnabled: input.backgroundEnabled,
      backgroundRefreshIntervalMs: plan.backgroundRefreshIntervalMs,
    }) === "background-task"
  )
    return true;
  return (
    plan.id === "free" &&
    account.lastActiveAt !== null &&
    account.lastActiveAt.getTime() + FREE_ACTIVITY_WINDOW_MS > now.getTime()
  );
}

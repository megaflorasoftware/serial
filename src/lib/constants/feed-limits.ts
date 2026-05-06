import { IS_DEMO_INSTANCE } from "~/lib/demo";

export const FEED_LIMIT_COPY = {
  bulkActivateOverLimit: (overLimit: number) =>
    IS_DEMO_INSTANCE
      ? `${overLimit} feed${overLimit > 1 ? "s would" : " would"} exceed the demo limit.`
      : `${overLimit} feed${overLimit > 1 ? "s would" : " would"} exceed your plan limit. To unlock more active feeds, you can switch to a higher plan.`,

  bulkActivateActionLabel: IS_DEMO_INSTANCE ? "View Plans" : "Upgrade",

  maxActiveFeedsAlertTitle: "Max active feeds reached",

  maxActiveFeedsAlertDescription: (planName: string, maxActiveFeeds: number) =>
    IS_DEMO_INSTANCE
      ? `The demo is limited to ${maxActiveFeeds} active feeds. You can add more than this, but only your active feeds will receive new content.`
      : `The ${planName} plan supports a maximum of ${maxActiveFeeds} feeds. You can add more than this, but only your active feeds will receive new content.`,

  maxActiveFeedsAlertButton: IS_DEMO_INSTANCE
    ? "View Plans"
    : "Upgrade your plan",

  singleFeedLimitReached: IS_DEMO_INSTANCE
    ? "Feed limit reached. This is the limit for the demo instance."
    : "Feed limit reached. Upgrade your plan to activate more feeds.",

  importDeactivated: (count: number) =>
    IS_DEMO_INSTANCE
      ? `${count} feed${count > 1 ? "s were" : " was"} added as inactive. This is the limit for the demo instance.`
      : `${count} feed${count > 1 ? "s were" : " was"} added as inactive. To unlock more active feeds, you can switch to a higher plan.`,

  importDeactivatedActionLabel: IS_DEMO_INSTANCE ? "View Plans" : "Upgrade",
} as const;

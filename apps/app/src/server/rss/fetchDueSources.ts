import { resolveAutomaticRssOwner } from "./automaticOwnership";
import { countDueFeeds, getDueFeedPage } from "./dueFeeds";
import { refreshUserFeeds } from "./refreshUserFeeds";
import { addRefreshStats, emptyRefreshStats, rssAttemptSummary } from "./stats";
import type { syncPublicationSubscriptions } from "~/server/publication-sync/engine";
import type { RefreshStats } from "./stats";
import type { FetchableOrigin } from "./types";
import type { db as Database } from "~/server/db";
import type {
  FetchDueSourcesResult,
  RssPublishedChunk,
  RssTrigger,
} from "~/lib/rss";
import { syncBeforeFeedRefresh } from "~/server/publication-sync/refresh";
import { checkUserRefreshEligibility } from "~/server/subscriptions/helpers";

type RefreshEligibility =
  | { eligible: true; nextRefreshAt: Date }
  | { eligible: false; nextRefreshAt: Date };

type FetchDueSourcesDependencies = {
  resolveOwner?: typeof resolveAutomaticRssOwner;
  claimUser?: (
    database: typeof Database,
    userId: string,
  ) => Promise<RefreshEligibility>;
  countDue?: typeof countDueFeeds;
  getDuePage?: typeof getDueFeedPage;
  refreshFeedPage?: (input: {
    db: typeof Database;
    feedsList: FetchableOrigin[];
    channel?: string;
    manual?: boolean;
  }) => Promise<RefreshStats>;
  now?: () => Date;
  syncSubscriptions?: typeof syncPublicationSubscriptions;
};

export async function fetchDueSources(input: {
  database: typeof Database;
  userId: string;
  trigger: RssTrigger;
  channel: string;
  publish: (channel: string, chunk: RssPublishedChunk) => Promise<void>;
  dependencies?: FetchDueSourcesDependencies;
}): Promise<FetchDueSourcesResult> {
  const dependencies = input.dependencies ?? {};
  const resolveOwner = dependencies.resolveOwner ?? resolveAutomaticRssOwner;
  if (
    input.trigger === "automatic" &&
    (await resolveOwner({
      database: input.database,
      userId: input.userId,
    })) === "background-task"
  ) {
    return { status: "background-managed" };
  }

  const claimUser = dependencies.claimUser ?? checkUserRefreshEligibility;
  const eligibility = await claimUser(input.database, input.userId);
  if (!eligibility.eligible) {
    return { status: "cooldown", nextRefreshAt: eligibility.nextRefreshAt };
  }

  const syncStarted = await syncBeforeFeedRefresh({
    database: input.database,
    userId: input.userId,
    channel: input.channel,
    nextRefreshAt: eligibility.nextRefreshAt,
    publish: input.publish,
    sync: dependencies.syncSubscriptions,
  });
  const now = dependencies.now?.() ?? new Date();
  const countDue = dependencies.countDue ?? countDueFeeds;
  const getDuePage = dependencies.getDuePage ?? getDueFeedPage;
  const refreshFeedPage = dependencies.refreshFeedPage ?? refreshUserFeeds;
  const totalFeeds = await countDue(input.database, input.userId, now);
  await input.publish(
    input.channel,
    syncStarted
      ? { type: "refresh-progress", total: totalFeeds, completed: 0 }
      : {
          type: "refresh-start",
          totalFeeds,
          nextRefreshAt: eligibility.nextRefreshAt,
        },
  );

  const stats = emptyRefreshStats();
  try {
    let afterFeedId: number | undefined;
    while (true) {
      // Cursor pages preserve the background worker's bounded Feed loading.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const feedPage = await getDuePage(input.database, {
        userId: input.userId,
        afterFeedId,
        now,
      });
      if (feedPage.length === 0) break;
      afterFeedId = feedPage.at(-1)?.feed.id;
      // Each page must finish before its cursor advances.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      const pageStats = await refreshFeedPage({
        db: input.database,
        feedsList: feedPage,
        channel: input.channel,
        manual: input.trigger === "manual",
      });
      addRefreshStats(stats, pageStats);
    }
  } catch (error) {
    await input.publish(input.channel, {
      type: "rss-attempt-complete",
      ...rssAttemptSummary(stats, "failed"),
    });
    throw error;
  }

  const outcome = stats.errorCount > 0 ? "partial" : "completed";
  const summary = rssAttemptSummary(stats, outcome);
  await input.publish(input.channel, {
    type: "rss-attempt-complete",
    ...summary,
  });
  return {
    status: outcome,
    nextRefreshAt: eligibility.nextRefreshAt,
    ...summary,
  };
}

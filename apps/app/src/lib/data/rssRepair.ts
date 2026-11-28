import type {
  ReconciliationScopeTarget,
  ReconciliationTarget,
} from "~/lib/reconciliation";
import type { RssAttemptSummary } from "~/lib/rss";
import type { DatabaseFeedCategory } from "~/server/db/schema";
import { buildContentStatusKey } from "~/lib/content-status";

export type RssRepairMemberships = {
  viewFeedIds: Record<number, number[]>;
  feedCategories: DatabaseFeedCategory[];
};

export function rssSummaryAffectsTarget(
  summary: RssAttemptSummary,
  target: ReconciliationScopeTarget,
  memberships: RssRepairMemberships,
) {
  const contentStatusKey = buildContentStatusKey(target.contentStatus);
  const affectedFeedIds = new Set(
    summary.affectedFeeds.flatMap((feed) =>
      feed.contentStatusKeys.includes(contentStatusKey) ? [feed.feedId] : [],
    ),
  );
  if (affectedFeedIds.size === 0) return false;
  if (target.scope.type === "feed") {
    return affectedFeedIds.has(target.scope.feedId);
  }
  if (target.scope.type === "tag") {
    const tagId = target.scope.tagId;
    return memberships.feedCategories.some(
      (assignment) =>
        assignment.categoryId === tagId &&
        affectedFeedIds.has(assignment.feedId),
    );
  }
  return (memberships.viewFeedIds[target.scope.viewId] ?? []).some((feedId) =>
    affectedFeedIds.has(feedId),
  );
}

export function rssRepairTargets(
  summary: RssAttemptSummary,
  activeTarget: ReconciliationScopeTarget | null,
  memberships: RssRepairMemberships,
): ReconciliationTarget[] {
  const targets: ReconciliationTarget[] = [];
  if (summary.metadataChanged) targets.push({ type: "organization" });
  if (summary.metadataChanged || summary.affectedFeeds.length > 0)
    targets.push({ type: "navigation" });
  if (
    activeTarget &&
    rssSummaryAffectsTarget(summary, activeTarget, memberships)
  )
    targets.push(activeTarget);
  return targets;
}

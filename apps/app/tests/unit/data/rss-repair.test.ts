import { describe, expect, it } from "vitest";
import type { ReconciliationScopeTarget } from "~/lib/reconciliation";
import type { RssAttemptSummary } from "~/lib/rss";
import {
  rssRepairTargets,
  rssSummaryAffectsTarget,
} from "~/lib/data/rssRepair";

const summary: RssAttemptSummary = {
  outcome: "partial",
  refreshedCount: 1,
  skippedCount: 0,
  emptyCount: 0,
  errorCount: 1,
  totalRowsWritten: 2,
  affectedFeeds: [{ feedId: 7, contentStatusKeys: ["inbox:unread"] }],
  originFailureFeedIds: [8],
};

const memberships = {
  viewFeedIds: { 10: [7], 11: [8] },
  feedCategories: [{ feedId: 7, categoryId: 20 }],
};

function target(
  scope: ReconciliationScopeTarget["scope"],
  contentStatus: ReconciliationScopeTarget["contentStatus"] = {
    saveStatus: "inbox",
    archiveStatus: "unread",
  },
): ReconciliationScopeTarget {
  return { type: "scope", scope, contentStatus };
}

describe("RSS repair targeting", () => {
  it("intersects committed Feed writes with actual organization membership", () => {
    expect(
      rssSummaryAffectsTarget(
        summary,
        target({ type: "feed", feedId: 7 }),
        memberships,
      ),
    ).toBe(true);
    expect(
      rssSummaryAffectsTarget(
        summary,
        target({ type: "view", viewId: 10 }),
        memberships,
      ),
    ).toBe(true);
    expect(
      rssSummaryAffectsTarget(
        summary,
        target({ type: "tag", tagId: 20 }),
        memberships,
      ),
    ).toBe(true);
    expect(
      rssSummaryAffectsTarget(
        summary,
        target({ type: "view", viewId: 11 }),
        memberships,
      ),
    ).toBe(false);
  });

  it("does not repair a different Content status for the same Feed", () => {
    expect(
      rssSummaryAffectsTarget(
        summary,
        target(
          { type: "feed", feedId: 7 },
          { saveStatus: "saved", archiveStatus: "unread" },
        ),
        memberships,
      ),
    ).toBe(false);
  });
});

it("combines metadata and item targets in the completion repair", () => {
  const active = target({ type: "feed", feedId: 7 });
  expect(
    rssRepairTargets(
      { ...summary, metadataChanged: true },
      active,
      memberships,
    ),
  ).toEqual([{ type: "organization" }, { type: "navigation" }, active]);
  expect(
    rssRepairTargets(
      { ...summary, affectedFeeds: [], metadataChanged: true },
      active,
      memberships,
    ),
  ).toEqual([{ type: "organization" }, { type: "navigation" }]);
  expect(
    rssRepairTargets({ ...summary, affectedFeeds: [] }, active, memberships),
  ).toEqual([]);
});

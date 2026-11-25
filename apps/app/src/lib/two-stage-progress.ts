/**
 * Adding many Feeds runs in two stages, for an OPML import and a subscription
 * sync alike. Finding checks each entry and creates its Feed. Fetching then
 * runs the first content fetch of every Feed it created. Both count Feeds,
 * never their origins.
 */
export type TwoStageProgress = {
  stage: "finding" | "fetching";
  completed: number;
  total: number;
};

const STAGES = {
  finding: { step: 1, label: "Finding feeds" },
  fetching: { step: 2, label: "Fetching content" },
} satisfies Record<TwoStageProgress["stage"], unknown>;

/** Where finding starts, before any entry is checked. */
export function findingProgress(total: number): TwoStageProgress {
  return { stage: "finding", completed: 0, total };
}

/** "Finding feeds 3 of 12 (Step 1 of 2)" */
export function twoStageProgressLabel(progress: TwoStageProgress) {
  const { step, label } = STAGES[progress.stage];
  return `${label} ${progress.completed} of ${progress.total} (Step ${step} of 2)`;
}

/** How full the bar is within the current stage, from 0 to 100. */
export function twoStageProgressPercent(progress: TwoStageProgress) {
  return progress.total
    ? Math.min(100, (progress.completed / progress.total) * 100)
    : 0;
}

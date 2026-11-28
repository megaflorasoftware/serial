import type { TwoStageProgress } from "~/lib/two-stage-progress";

export type PublicationSyncCounts = {
  imported: number;
  exported: number;
  inactive: number;
  removed: number;
  failed: number;
  skipped: number;
  deferred: number;
};
export type PublicationSyncResult = PublicationSyncCounts & {
  retryAt?: Date;
  status: "completed" | "partial" | "skipped" | "busy";
};
/** One run's count in its current stage. */
export type PublicationSyncProgress = TwoStageProgress & { runId: string };
export const emptyPublicationSyncCounts = (): PublicationSyncCounts => ({
  imported: 0,
  exported: 0,
  inactive: 0,
  removed: 0,
  failed: 0,
  skipped: 0,
  deferred: 0,
});

export type PublicationSyncJobStatus = {
  runId: string;
  pending: boolean;
  running: boolean;
  /** The request's count across its runs. */
  progress: TwoStageProgress | null;
  result: PublicationSyncResult | null;
};

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
export type PublicationSyncProgress = {
  runId: string;
  completed: number;
  total: number;
};
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
  progress: { completed: number; total: number } | null;
  result: PublicationSyncResult | null;
};

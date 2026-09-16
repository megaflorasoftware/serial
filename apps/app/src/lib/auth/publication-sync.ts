export type PublicationSyncCounts = {
  imported: number;
  exported: number;
  inactive: number;
  removed: number;
  failed: number;
  deferred: number;
};
export type PublicationSyncResult = PublicationSyncCounts & {
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
  deferred: 0,
});

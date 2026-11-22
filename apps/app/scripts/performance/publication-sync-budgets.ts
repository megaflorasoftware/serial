import type { PublicationSyncOperation } from "./publication-sync-workload";

/**
 * Structural budgets shared by the deterministic bounds test and the benchmark
 * runner. Only a requested pass may grow with the number of publications.
 */
export function publicationSyncBudget(
  operation: PublicationSyncOperation,
  publications: number,
) {
  return {
    // One read of the connection; the PDS answers the rest.
    unchanged: { requests: 1, statements: 1, rows: 1 },
    // The due-job page and one guarded reschedule.
    check: { requests: 1, statements: 2, rows: 1 },
    // The same, however many imports wait for their retry time.
    waiting: { requests: 1, statements: 2, rows: 1 },
    // Claim, mirror, local origins, cursor and release.
    requested: { requests: 2, statements: 8, rows: publications * 2 + 5 },
  }[operation];
}

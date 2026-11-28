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
    // The same two statements, with one listing beside the revision read.
    moved: { requests: 2, statements: 2, rows: 1 },
    // The check's revision and listing, the run's second revision read, one
    // rewritten subscription's observation, and the one read for Feeds still
    // awaiting their first fetch. Both counts are the measured ones, with no
    // headroom to hide a later statement in.
    changed: { requests: 3, statements: 16, rows: publications * 2 + 5 },
    // Claim, mirror, local origins, the Feeds awaiting a first fetch, cursor
    // and release. The listing sits between two revision reads.
    requested: { requests: 3, statements: 8, rows: publications * 2 + 5 },
  }[operation];
}

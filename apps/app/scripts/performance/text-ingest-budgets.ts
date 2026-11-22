import type { TextIngestOperation } from "./text-ingest-workload";

/**
 * Structural budgets shared by the deterministic bounds test and the benchmark
 * runner. An unchanged feed costs the narrow identity read whatever its size;
 * only the items a feed states differently are read in full and written.
 */
export function textIngestBudget(
  operation: TextIngestOperation,
  items: number,
  changed: number,
) {
  // One row per item and observation, then one per alias.
  const identityRows = items * 2;
  return {
    // The two identity statements and nothing else.
    unchanged: { statements: 2, rows: identityRows, writes: 0 },
    // Identity, the changed items in full, the reread under the lock, then
    // one statement each for items and observations.
    changed: {
      statements: 9,
      rows: identityRows + changed * 6,
      writes: 2,
    },
  }[operation];
}

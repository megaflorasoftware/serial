/**
 * Structural budget shared by the deterministic bounds test and the benchmark
 * runner. Revalidation costs the same whatever the Feed's history.
 */
export const feedRevalidationBudget = {
  // Includes the one statement that tells subscription sync about an attached
  // publication.
  statements: 21,
  rows: 20,
  sourceReads: 3,
} as const;

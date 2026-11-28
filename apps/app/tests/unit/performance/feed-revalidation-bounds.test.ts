import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { feedRevalidationBudget } from "../../../scripts/performance/feed-revalidation-budgets";
import { createFeedRevalidationWorkload } from "../../../scripts/performance/feed-revalidation-workload";

it.each([1000, 10000, 50000])(
  "revalidates a Feed with %s historical items using constant work",
  async (size) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      const workload = await createFeedRevalidationWorkload(
        session.database,
        size,
      );
      session.instrumentation.reset();
      const result = await workload.run();
      expect(result.changed).toBe(true);
      expect(result.feed.origins).toHaveLength(2);
      const evidence = session.instrumentation.snapshot();
      expect(evidence.statementCount).toBeLessThanOrEqual(
        feedRevalidationBudget.statements,
      );
      expect(evidence.materializedRows).toBeLessThanOrEqual(
        feedRevalidationBudget.rows,
      );
      expect(workload.reads).toBe(feedRevalidationBudget.sourceReads);
      expect(
        evidence.statements.some((statement) =>
          statement.sql.includes('"serial_feed_item"'),
        ),
      ).toBe(false);
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30000,
);

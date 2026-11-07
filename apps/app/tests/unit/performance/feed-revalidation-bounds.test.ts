import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
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
      expect((await workload.run()).origins).toHaveLength(2);
      const evidence = session.instrumentation.snapshot();
      expect(evidence.statementCount).toBeLessThanOrEqual(20);
      expect(evidence.materializedRows).toBeLessThanOrEqual(20);
      expect(workload.reads).toBe(3);
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

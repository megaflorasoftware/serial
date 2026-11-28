import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createFeedImportWorkload } from "../../../scripts/performance/feed-import-workload";

it.each([100, 1_000])(
  "bounds verified import queries and source reads among %s Feeds",
  async (count) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      const workload = await createFeedImportWorkload(session.database, count);
      session.instrumentation.reset();
      expect(await workload.run()).toMatchObject({
        created: false,
        attached: true,
      });
      const evidence = session.instrumentation.snapshot();
      expect(workload.sourceReads).toBe(2);
      expect(evidence.statementCount).toBeLessThanOrEqual(16);
      expect(evidence.materializedRows).toBeLessThanOrEqual(20);
      expect(
        evidence.statements.some((statement) =>
          statement.sql.includes("serial_feed_item"),
        ),
      ).toBe(false);
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30_000,
);

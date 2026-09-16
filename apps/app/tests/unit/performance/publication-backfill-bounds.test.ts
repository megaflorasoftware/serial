import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createPublicationBackfillWorkload } from "../../../scripts/performance/publication-backfill-workload";
import { BACKFILL_BATCH_SIZE } from "~/server/publication-sync/backfill";

it.each([100, 1000])(
  "bounds first backfill work with %s existing Feeds",
  async (count) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      const workload = await createPublicationBackfillWorkload(
        session.database,
        count,
      );
      session.instrumentation.reset();
      expect(await workload.run()).toMatchObject({
        attached: 0,
        retryAt: expect.any(Date),
      });
      const evidence = session.instrumentation.snapshot();
      expect(workload.requests).toBe(BACKFILL_BATCH_SIZE * 2);
      expect(evidence.statementCount).toBeLessThanOrEqual(75);
      expect(evidence.materializedRows).toBeLessThanOrEqual(75);
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

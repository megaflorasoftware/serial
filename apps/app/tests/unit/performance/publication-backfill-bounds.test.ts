import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import {
  BACKFILL_BENCHMARK_CHECKS,
  createPublicationBackfillWorkload,
} from "../../../scripts/performance/publication-backfill-workload";
import { feedOriginChecks } from "~/server/db/schema";

it.each([100, 1000])(
  "bounds queued backfill work with %s existing Feeds",
  async (count) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      const workload = await createPublicationBackfillWorkload(
        session.database,
        count,
      );
      // Queueing every existing Feed is one statement that returns nothing.
      session.instrumentation.reset();
      await workload.prepare();
      const queued = session.instrumentation.snapshot();
      expect(
        queued.statements.filter((statement) =>
          statement.sql.startsWith('insert into "serial_feed_origin_checks"'),
        ),
      ).toHaveLength(1);
      session.instrumentation.reset();
      expect(await workload.run()).toEqual({ more: false });
      const evidence = session.instrumentation.snapshot();
      expect(workload.requests).toBe(BACKFILL_BENCHMARK_CHECKS * 2);
      expect(evidence.statementCount).toBeLessThanOrEqual(75);
      expect(evidence.materializedRows).toBeLessThanOrEqual(75);
      expect(
        evidence.statements.some((statement) =>
          statement.sql.includes('"serial_feed_item"'),
        ),
      ).toBe(false);
      expect(await session.database.$count(feedOriginChecks)).toBe(
        count - BACKFILL_BENCHMARK_CHECKS,
      );
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30000,
);

import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createIngestWorkload } from "../../../scripts/performance/ingest-workload";
import { createPageImageWorkload } from "../../../scripts/performance/page-image-workload";

it.each([1_000, 10_000, 50_000])(
  "repairs eight page images through indexed bounded reads with %s stored items",
  async (historySize) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      await createIngestWorkload(session.database, historySize);
      const workload = await createPageImageWorkload(session.database);
      await workload.prepare();
      session.instrumentation.reset();
      expect(await workload.run()).toHaveLength(8);
      const evidence = session.instrumentation.snapshot();
      expect(workload.requests).toBe(8);
      expect(evidence.materializedRows).toBeLessThanOrEqual(40);
      expect(evidence.statementCount).toBeLessThanOrEqual(25);
      const due = evidence.statements.find((entry) =>
        entry.sql.includes('order by "serial_feed_item_page_image"'),
      )!;
      expect(due).toBeDefined();
      const plan = await session.baseClient.execute({
        sql: `EXPLAIN QUERY PLAN ${due.sql}`,
        args: [1, Date.now(), 8],
      });
      const details = plan.rows.map((row) => String(row.detail)).join("\n");
      expect(details).toContain("feed_item_page_image_due_idx");
      expect(details).not.toMatch(/SCAN|TEMP B-TREE/);
      session.instrumentation.reset();
      expect(await workload.run()).toHaveLength(0);
      expect(session.instrumentation.snapshot().materializedRows).toBe(0);
    } finally {
      session.close();
      target.cleanup();
    }
  },
  60_000,
);

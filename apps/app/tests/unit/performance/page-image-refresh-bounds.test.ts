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
      await createIngestWorkload(session.database, 0);
      // Seed history in one statement so fixture setup does not dominate this bound check.
      await session.baseClient.execute({
        sql: `WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ?)
          INSERT INTO serial_feed_item (id, feed_id, content_id, title, author, url, posted_at, created_at, updated_at)
          SELECT 'old-' || n, (SELECT id FROM serial_feed WHERE user_id = 'ingest-benchmark'),
            'old-' || n, 'Old item', 'Author', 'https://example.com/old/' || n, 0, 0, 0 FROM history`,
        args: [historySize],
      });
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

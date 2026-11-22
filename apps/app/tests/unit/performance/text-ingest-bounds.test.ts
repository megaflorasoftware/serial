import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { textIngestBudget } from "../../../scripts/performance/text-ingest-budgets";
import { createTextIngestWorkload } from "../../../scripts/performance/text-ingest-workload";

const WRITE = /^(insert into|update|delete from) /i;
// The item's body and the observation's value: neither may be read to find
// that nothing changed.
const BODY_COLUMN = /"serial_feed_item"\."content"|"content",|"value"/;

it.each([30, 200])(
  "reads no body and writes nothing for an unchanged feed of %s items",
  async (size) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      const workload = await createTextIngestWorkload(session.database, size);
      session.instrumentation.reset();
      expect(await workload.run("unchanged")).toEqual({ written: 0 });
      const unchanged = session.instrumentation.snapshot();
      const budget = textIngestBudget("unchanged", size, 0);
      expect(unchanged.statementCount).toBe(budget.statements);
      expect(unchanged.materializedRows).toBeLessThanOrEqual(budget.rows);
      expect(
        unchanged.statements.filter((entry) => WRITE.test(entry.sql)),
      ).toHaveLength(budget.writes);
      expect(
        unchanged.statements.filter((entry) => BODY_COLUMN.test(entry.sql)),
      ).toEqual([]);
      expect(workload.pages).toBe(0);

      session.instrumentation.reset();
      expect(await workload.run("changed", 3)).toEqual({ written: 3 });
      const changed = session.instrumentation.snapshot();
      const changedBudget = textIngestBudget("changed", size, 3);
      expect(changed.statementCount).toBeLessThanOrEqual(
        changedBudget.statements,
      );
      // Only the three edited items are read in full.
      expect(changed.materializedRows).toBeLessThanOrEqual(changedBudget.rows);
      expect(
        changed.statements.some((entry) => BODY_COLUMN.test(entry.sql)),
      ).toBe(true);
      expect(
        changed.statements.filter((entry) => WRITE.test(entry.sql)),
      ).toHaveLength(changedBudget.writes);

      // Inspect plans after writes: local libSQL EXPLAIN can retain a read lock.
      for (const { sql } of unchanged.statements) {
        const plan = await session.baseClient.execute({
          sql: `EXPLAIN QUERY PLAN ${sql}`,
          args: Array.from(sql.matchAll(/\?/g), () => "lookup"),
        });
        const details = plan.rows.map((row) => String(row.detail)).join("\n");
        expect(details).not.toMatch(/SCAN serial_feed_item/);
        expect(details).not.toMatch(
          /serial_feed_item_alias USING INDEX \S+ \(feed_id=\?\)$/m,
        );
      }
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30000,
);

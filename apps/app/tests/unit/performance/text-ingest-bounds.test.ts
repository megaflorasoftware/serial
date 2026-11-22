import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import {
  readsBehindItemBody,
  textIngestBudget,
  textIngestOverruns,
} from "../../../scripts/performance/text-ingest-budgets";
import { createTextIngestWorkload } from "../../../scripts/performance/text-ingest-workload";

it.each([30, 200])(
  "reads no body, nothing behind one, and writes nothing for an unchanged feed of %s items",
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
      // Neither the item's body nor the observation's value is read to find
      // that nothing changed, and nothing is written.
      expect(textIngestOverruns(budget, unchanged)).toEqual([]);
      expect(workload.pages).toBe(0);

      session.instrumentation.reset();
      expect(await workload.run("changed", 3)).toEqual({ written: 3 });
      const changed = session.instrumentation.snapshot();
      // Only the three edited items are read in full.
      expect(
        textIngestOverruns(textIngestBudget("changed", size, 3), changed),
      ).toEqual([]);

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
        // Every item here is observed: its row gives up only what sits ahead
        // of the body, so no overflow page is walked to tell it is unchanged.
        expect(await readsBehindItemBody(session.baseClient, sql)).toEqual([]);
      }
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30000,
);

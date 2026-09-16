import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createIngestWorkload } from "../../../scripts/performance/ingest-workload";

describe("Atmosphere ingest resource bounds", () => {
  it.each([1_000, 10_000, 50_000])(
    "keeps import and edit work bounded with %s stored items",
    async (historySize) => {
      const target = createLocalBenchmarkTarget();
      const session = openBenchmarkDatabase({ url: target.url });
      try {
        await applyMigrations(session.baseClient);
        const workload = await createIngestWorkload(
          session.database,
          historySize,
        );
        session.instrumentation.reset();
        expect((await workload.run(false)).status).toBe("success");
        let evidence = session.instrumentation.snapshot();
        expect(workload.requests).toBe(4);
        expect(evidence.statementCount).toBeLessThanOrEqual(40);
        expect(evidence.materializedRows).toBeLessThanOrEqual(210);
        session.instrumentation.reset();
        expect((await workload.run(true)).status).toBe("success");
        evidence = session.instrumentation.snapshot();
        expect(workload.requests).toBe(3);
        const lookup = evidence.statements.find((entry) =>
          entry.sql.includes(" union "),
        );
        expect(lookup).toBeDefined();
        const plan = await session.baseClient.execute({
          sql: `EXPLAIN QUERY PLAN ${lookup!.sql}`,
          args: Array.from(lookup!.sql.matchAll(/\?/g), () => "lookup"),
        });
        const details = plan.rows.map((row) => String(row.detail)).join("\n");
        expect(details).toContain("feed_item_feed_normalized_url_idx");
        expect(details).toContain("feed_item_feed_atproto_uri_unique");
        expect(details).not.toMatch(/SCAN serial_feed_item/);

        expect(evidence.statementCount).toBeLessThanOrEqual(30);
        expect(evidence.materializedRows).toBeLessThanOrEqual(610);
        session.instrumentation.reset();
        expect((await workload.run(false)).status).toBe("skipped");
        evidence = session.instrumentation.snapshot();
        expect(workload.requests).toBe(1);
        expect(evidence.statementCount).toBeLessThanOrEqual(4);
        expect(evidence.materializedRows).toBeLessThanOrEqual(2);
      } finally {
        session.close();
        target.cleanup();
      }
    },
    30_000,
  );
});

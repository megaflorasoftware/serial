import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createPublicationSyncWorkload } from "../../../scripts/performance/publication-sync-workload";

describe("publication subscription sync bounds", () => {
  it.each([100, 1_000])(
    "uses constant statements and one revision request for %s unchanged publications",
    async (count) => {
      const target = createLocalBenchmarkTarget();
      const session = openBenchmarkDatabase({ url: target.url });
      try {
        await applyMigrations(session.baseClient);
        const workload = await createPublicationSyncWorkload(
          session.database,
          count,
        );
        session.instrumentation.reset();
        expect(await workload.run()).toMatchObject({
          status: "completed",
          imported: 0,
          exported: 0,
          removed: 0,
        });
        const evidence = session.instrumentation.snapshot();
        expect(workload.requests).toBe(1);
        expect(evidence.statementCount).toBeLessThanOrEqual(8);
        expect(evidence.materializedRows).toBeLessThanOrEqual(count * 2 + 5);
        expect(
          evidence.statements.some((statement) =>
            statement.sql.includes("serial_feed_item"),
          ),
        ).toBe(false);
        expect(
          evidence.statements.filter((statement) =>
            /^(insert|delete)/i.test(statement.sql),
          ),
        ).toHaveLength(0);
      } finally {
        session.close();
        target.cleanup();
      }
    },
    30_000,
  );
});

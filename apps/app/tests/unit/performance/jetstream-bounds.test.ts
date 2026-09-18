import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createJetstreamWorkload } from "../../../scripts/performance/jetstream-workload";

it.each([1000, 10000, 50000])(
  "bounds event work independently of %s retained items",
  async (history) => {
    const target = createLocalBenchmarkTarget();
    const session = openBenchmarkDatabase({ url: target.url });
    try {
      await applyMigrations(session.baseClient);
      const workload = await createJetstreamWorkload(
        session.database,
        3,
        history,
      );
      for (const mode of [
        "changed",
        "duplicate",
        "idle",
        "ineligible",
      ] as const) {
        session.instrumentation.reset();
        const result = await workload.run(mode);
        const evidence = session.instrumentation.snapshot();
        expect(evidence.materializedRows).toBeLessThanOrEqual(185);
        expect(evidence.statementCount).toBeLessThanOrEqual(180);
        expect(result.publications).toBe(mode === "changed" ? 3 : 0);
        if (mode !== "changed")
          expect(
            evidence.statements.filter((entry) =>
              /^(insert into|update|delete from) "serial_feed_item"/i.test(
                entry.sql,
              ),
            ),
          ).toHaveLength(0);
      }
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30000,
);

import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createJetstreamWorkload } from "../../../scripts/performance/jetstream-workload";
import { interruptStream } from "~/server/jetstream/store";
import { recordUserActivity } from "~/server/jetstream/activity";

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
      const lookups: string[] = [];
      for (const bootstrap of [true, false]) {
        session.instrumentation.reset();
        const result = await workload.recover(bootstrap);
        const evidence = session.instrumentation.snapshot();
        expect(result.pages).toBe(2);
        expect(result.images).toBeLessThanOrEqual(8);
        expect(evidence.materializedRows).toBeLessThanOrEqual(1600);
        expect(evidence.statementCount).toBeLessThanOrEqual(700);
        const lookup = evidence.statements.find((entry) =>
          entry.sql.includes(" union "),
        );
        expect(lookup).toBeDefined();
        lookups.push(lookup!.sql);
      }
      await workload.prepareHealthy();
      session.instrumentation.reset();
      expect(await workload.check()).toEqual({ requests: 0 });
      expect(
        session.instrumentation.snapshot().statementCount,
      ).toBeLessThanOrEqual(10);
      expect(
        session.instrumentation.snapshot().materializedRows,
      ).toBeLessThanOrEqual(5);
      session.instrumentation.reset();
      await interruptStream(session.database, "benchmark", true);
      const interruption = session.instrumentation.snapshot();
      expect(interruption.statementCount).toBe(1);
      expect(interruption.materializedRows).toBe(1);
      expect(
        interruption.statements.some((entry) =>
          /update "serial_feed_origin/.test(entry.sql),
        ),
      ).toBe(false);
      const activityTime = new Date(Date.now() + 10 * 60 * 1000);
      for (const changedRows of [1, 0]) {
        session.instrumentation.reset();
        const result = await recordUserActivity(
          session.database,
          "stream-benchmark-0",
          activityTime,
        );
        expect(result.rowsAffected).toBe(changedRows);
        expect(session.instrumentation.snapshot()).toMatchObject({
          statementCount: 1,
          materializedRows: 0,
        });
      }
      // Inspect plans after writes: local libSQL EXPLAIN can retain a read lock.
      for (const lookup of lookups) {
        const plan = await session.baseClient.execute({
          sql: `EXPLAIN QUERY PLAN ${lookup}`,
          args: Array.from(lookup.matchAll(/\?/g), () => "lookup"),
        });
        const details = plan.rows.map((row) => String(row.detail)).join("\n");
        expect(details).toContain("feed_item_feed_normalized_url_idx");
        expect(details).toContain("feed_item_feed_atproto_uri_unique");
        expect(details).not.toMatch(/SCAN serial_feed_item/);
      }
    } finally {
      session.close();
      target.cleanup();
    }
  },
  30000,
);

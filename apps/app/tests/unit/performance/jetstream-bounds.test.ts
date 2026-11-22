import { expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createJetstreamWorkload } from "../../../scripts/performance/jetstream-workload";
import { declareStreamGap, disconnectStream } from "~/server/jetstream/store";
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
      const platformChecks: string[] = [];
      for (const mode of [
        "changed",
        "duplicate",
        "idle",
        "ineligible",
      ] as const) {
        session.instrumentation.reset();
        const result = await workload.run(mode);
        const evidence = session.instrumentation.snapshot();
        platformChecks.push(
          ...evidence.statements
            .map((entry) => entry.sql)
            .filter((sql) => sql.includes('"body_content_type" asc')),
        );
        // The platform is never read back out of the retained sources.
        expect(
          evidence.statements.filter((entry) =>
            entry.sql.includes("json_extract"),
          ),
        ).toEqual([]);
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
        // A bootstrap stops at the newest 100; a later scan pages to the end.
        expect(result.pages).toBe(bootstrap ? 1 : 2);
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
      // A network event for a publisher nobody follows costs no statement.
      const intake = await workload.intake();
      session.instrumentation.reset();
      expect(await intake.skip()).toEqual({ applied: 0 });
      expect(session.instrumentation.snapshot().statementCount).toBe(0);
      // The heartbeat's look for new origins is one statement returning nothing.
      session.instrumentation.reset();
      await intake.refresh();
      expect(session.instrumentation.snapshot()).toMatchObject({
        statementCount: 1,
        materializedRows: 0,
      });
      // An idle retry sweep is one statement over the pending-work indexes.
      session.instrumentation.reset();
      expect(await workload.sweep()).toEqual({ publications: 0 });
      const sweep = session.instrumentation.snapshot();
      expect(sweep).toMatchObject({ statementCount: 1, materializedRows: 0 });
      const sweepSql = sweep.statements[0]!.sql;
      // Ending a connection is one marker write whatever the Feed count.
      session.instrumentation.reset();
      await disconnectStream(session.database, "benchmark");
      expect(session.instrumentation.snapshot()).toMatchObject({
        statementCount: 1,
        materializedRows: 0,
      });
      // A gap is the marker's write, then one statement that makes the covered
      // origins due.
      session.instrumentation.reset();
      await declareStreamGap(session.database, "benchmark", new Date());
      const gap = session.instrumentation.snapshot();
      expect(gap.statementCount).toBe(2);
      expect(gap.materializedRows).toBe(1);
      expect(
        gap.statements.filter((entry) =>
          /update "serial_feed_origin/.test(entry.sql),
        ),
      ).toHaveLength(1);
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
      const sweepPlan = await session.baseClient.execute({
        sql: `EXPLAIN QUERY PLAN ${sweepSql}`,
        args: Array.from(sweepSql.matchAll(/\?/g), () => 0),
      });
      const sweepDetails = sweepPlan.rows
        .map((row) => String(row.detail))
        .join("\n");
      expect(sweepDetails).toContain("feed_origin_atproto_document_retry_idx");
      expect(sweepDetails).toContain("feed_origin_atproto_dirty_idx");
      expect(sweepDetails).not.toMatch(
        /SCAN serial_feed_origin_atproto(_document)?\b(?! USING)/,
      );
      // A committed document rechecks the platform against the retained
      // history with two index seeks, however long that history is.
      expect(platformChecks).toHaveLength(3);
      const platformPlan = await session.baseClient.execute({
        sql: `EXPLAIN QUERY PLAN ${platformChecks[0]!}`,
        args: Array.from(platformChecks[0]!.matchAll(/\?/g), () => 1),
      });
      const platformDetails = platformPlan.rows
        .map((row) => String(row.detail))
        .join("\n");
      expect(
        platformDetails.match(
          /COVERING INDEX feed_origin_atproto_document_body_type_idx \(origin_id=\? AND body_content_type>\?\)/g,
        ),
      ).toHaveLength(2);
      expect(platformDetails).not.toMatch(/TEMP B-TREE|document_source/);
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

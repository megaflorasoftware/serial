import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { createPublicationSyncWorkload } from "../../../scripts/performance/publication-sync-workload";
import { publicationSyncBudget } from "../../../scripts/performance/publication-sync-budgets";
import type { PublicationSyncOperation } from "../../../scripts/performance/publication-sync-workload";

async function measure(count: number, operation: PublicationSyncOperation) {
  const target = createLocalBenchmarkTarget();
  const session = openBenchmarkDatabase({ url: target.url });
  try {
    await applyMigrations(session.baseClient);
    const workload = await createPublicationSyncWorkload(
      session.database,
      count,
      operation,
    );
    await workload.prepare();
    session.instrumentation.reset();
    const result = await workload.run();
    return {
      result,
      requests: workload.requests,
      evidence: session.instrumentation.snapshot(),
    };
  } finally {
    session.close();
    target.cleanup();
  }
}
const writes = (statements: Array<{ sql: string }>) =>
  statements.filter((statement) =>
    /^(insert|update|delete)/i.test(statement.sql),
  );
const touches = (statements: Array<{ sql: string }>, table: string) =>
  statements.some((statement) => statement.sql.includes(table));

describe("publication subscription sync bounds", () => {
  it.each([100, 1_000])(
    "ends an unchanged inline run after one read for %s publications",
    async (count) => {
      const { result, requests, evidence } = await measure(count, "unchanged");
      expect(result).toMatchObject({ status: "completed", imported: 0 });
      expect(publicationSyncBudget("unchanged", count)).toMatchObject({
        statements: 1,
        rows: 1,
      });
      expect(requests).toBe(1);
      expect(evidence.statementCount).toBe(1);
      expect(evidence.materializedRows).toBe(1);
      expect(writes(evidence.statements)).toHaveLength(0);
    },
    30_000,
  );
  it.each([100, 1_000])(
    "ends an idle recurring check with one write and no mirror or origin rows for %s publications",
    async (count) => {
      const { requests, evidence } = await measure(count, "check");
      const budget = publicationSyncBudget("check", count);
      expect(requests).toBe(1);
      expect(evidence.statementCount).toBeLessThanOrEqual(budget.statements);
      expect(evidence.materializedRows).toBeLessThanOrEqual(budget.rows);
      expect(writes(evidence.statements)).toHaveLength(1);
      expect(
        touches(evidence.statements, "serial_atproto_subscription_mirror"),
      ).toBe(false);
      expect(touches(evidence.statements, "serial_feed_origin")).toBe(false);
    },
    30_000,
  );
  it.each([100, 1_000])(
    "uses constant statements for a requested pass over %s unchanged publications",
    async (count) => {
      const { result, requests, evidence } = await measure(count, "requested");
      const budget = publicationSyncBudget("requested", count);
      expect(result).toMatchObject({
        status: "completed",
        imported: 0,
        exported: 0,
        removed: 0,
      });
      expect(requests).toBe(2);
      expect(evidence.statementCount).toBeLessThanOrEqual(budget.statements);
      expect(evidence.materializedRows).toBeLessThanOrEqual(budget.rows);
      expect(touches(evidence.statements, "serial_feed_item")).toBe(false);
      expect(
        evidence.statements.filter((statement) =>
          /^(insert|delete)/i.test(statement.sql),
        ),
      ).toHaveLength(0);
    },
    30_000,
  );
});

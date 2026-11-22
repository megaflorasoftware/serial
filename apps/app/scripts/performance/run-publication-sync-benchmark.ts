import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BACKFILL_BATCH_SIZE } from "../../src/server/publication-sync/backfill";
import { createPublicationBackfillWorkload } from "./publication-backfill-workload";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import {
  createPublicationSyncWorkload,
  PUBLICATION_SYNC_OPERATIONS,
} from "./publication-sync-workload";
import { publicationSyncBudget } from "./publication-sync-budgets";
import type { PublicationSyncOperation } from "./publication-sync-workload";

const profiles = { small: 100, representative: 1_000, stress: 10_000 };
const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "representative" },
    // `sync` measures every sync operation in turn.
    operation: { type: "string", default: "sync" },
  },
});
if (!(values.profile in profiles))
  throw new Error("Unknown publication sync profile");
const isSyncOperation = (value: string): value is PublicationSyncOperation =>
  (PUBLICATION_SYNC_OPERATIONS as readonly string[]).includes(value);
const operations: Array<PublicationSyncOperation | "backfill"> =
  values.operation === "sync"
    ? [...PUBLICATION_SYNC_OPERATIONS]
    : values.operation === "backfill" || isSyncOperation(values.operation)
      ? [values.operation]
      : [];
if (!operations.length) throw new Error("Unknown operation");
const count = profiles[values.profile as keyof typeof profiles];

/** Each operation gets its own database, so one cannot warm or dirty another. */
async function measure(operation: PublicationSyncOperation | "backfill") {
  const target = createLocalBenchmarkTarget();
  const session = openBenchmarkDatabase({ url: target.url });
  try {
    await applyMigrations(session.baseClient);
    const workload =
      operation === "backfill"
        ? await createPublicationBackfillWorkload(session.database, count)
        : await createPublicationSyncWorkload(
            session.database,
            count,
            operation,
          );
    const budget =
      operation === "backfill"
        ? { requests: BACKFILL_BATCH_SIZE * 2, statements: 75, rows: 75 }
        : publicationSyncBudget(operation, count);
    if ("prepare" in workload) await workload.prepare();
    await workload.run();
    const samples = [];
    for (let index = 0; index < 15; index++) {
      // Reset this sample before measuring it; samples cannot overlap.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      if ("prepare" in workload) await workload.prepare();
      session.instrumentation.reset();
      const started = performance.now();
      // Samples must run separately; overlapping runs measure lease contention.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await workload.run();
      const elapsedMs = performance.now() - started;
      const evidence = session.instrumentation.snapshot();
      if (
        ("status" in result &&
          !["completed", "checked"].includes(result.status)) ||
        workload.requests !== budget.requests ||
        evidence.statementCount > budget.statements ||
        evidence.materializedRows > budget.rows
      )
        throw new Error(
          `Publication ${operation} exceeded its structural budget`,
        );
      samples.push({
        elapsedMs,
        statements: evidence.statementCount,
        rows: evidence.materializedRows,
      });
    }
    const times = samples
      .map((sample) => sample.elapsedMs)
      .sort((a, b) => a - b);
    const report = {
      profile: values.profile,
      operation,
      publications: count,
      medianMs: times[7],
      p95Ms: times[14],
      samples,
    };
    await mkdir("benchmarks/results", { recursive: true });
    await writeFile(
      `benchmarks/results/publication-${operation}-${values.profile}.json`,
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    session.close();
    target.cleanup();
  }
}

for (const operation of operations) {
  // One operation at a time: concurrent runs would measure each other's load.
  // react-doctor-disable-next-line react-doctor/async-await-in-loop
  await measure(operation);
}

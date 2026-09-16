import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BACKFILL_BATCH_SIZE } from "../../src/server/publication-sync/backfill";
import { createPublicationBackfillWorkload } from "./publication-backfill-workload";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createPublicationSyncWorkload } from "./publication-sync-workload";

const profiles = { small: 100, representative: 1_000, stress: 10_000 };
const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "representative" },
    operation: { type: "string", default: "sync" },
  },
});
if (!(values.profile in profiles))
  throw new Error("Unknown publication sync profile");
if (!["sync", "backfill"].includes(values.operation))
  throw new Error("Unknown operation");
const backfill = values.operation === "backfill";
const count = profiles[values.profile as keyof typeof profiles];
const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const workload = backfill
    ? await createPublicationBackfillWorkload(session.database, count)
    : await createPublicationSyncWorkload(session.database, count);
  await workload.run();
  const samples = [];
  for (let index = 0; index < 15; index++) {
    if ("prepare" in workload) await workload.prepare();
    session.instrumentation.reset();
    const started = performance.now();
    // Samples must run separately; overlapping runs measure lease contention.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await workload.run();
    const elapsedMs = performance.now() - started;
    const evidence = session.instrumentation.snapshot();
    if (backfill) {
      if (
        workload.requests !== BACKFILL_BATCH_SIZE * 2 ||
        evidence.statementCount > 75 ||
        evidence.materializedRows > 75
      )
        throw new Error("Backfill exceeded its structural budget");
    } else if (
      !("status" in result) ||
      result.status !== "completed" ||
      workload.requests !== 1 ||
      evidence.statementCount > 8 ||
      evidence.materializedRows > count * 2 + 5
    )
      throw new Error("Publication sync exceeded its structural budget");
    samples.push({
      elapsedMs,
      statements: evidence.statementCount,
      rows: evidence.materializedRows,
    });
  }
  const times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const report = {
    profile: values.profile,
    operation: values.operation,
    publications: count,
    medianMs: times[7],
    p95Ms: times[14],
    samples,
  };
  await mkdir("benchmarks/results", { recursive: true });
  await writeFile(
    `benchmarks/results/publication-${values.operation}-${values.profile}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  session.close();
  target.cleanup();
}

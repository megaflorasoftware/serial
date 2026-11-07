import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createFeedImportWorkload } from "./feed-import-workload";

const profiles = { small: 100, representative: 1_000, stress: 10_000 };
const { values } = parseArgs({
  options: { profile: { type: "string", default: "representative" } },
});
if (!(values.profile in profiles))
  throw new Error("Unknown Feed import profile");
const count = profiles[values.profile as keyof typeof profiles];
const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const workload = await createFeedImportWorkload(session.database, count);
  await workload.run();
  const samples = [];
  for (let index = 0; index < 15; index++) {
    // Every sample must start from the same unattached Feed.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await workload.reset();
    session.instrumentation.reset();
    const started = performance.now();
    // Concurrent samples would measure contention and share instrumentation.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await workload.run();
    const elapsedMs = performance.now() - started;
    const evidence = session.instrumentation.snapshot();
    if (
      result.created ||
      !result.attached ||
      workload.sourceReads !== 2 ||
      evidence.statementCount > 16 ||
      evidence.materializedRows > 20
    )
      throw new Error("Feed import exceeded its structural budget");
    samples.push({
      elapsedMs,
      statements: evidence.statementCount,
      rows: evidence.materializedRows,
      sourceReads: workload.sourceReads,
    });
  }
  const times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const report = {
    profile: values.profile,
    feeds: count,
    medianMs: times[7],
    p95Ms: times[14],
    samples,
  };
  await mkdir("benchmarks/results", { recursive: true });
  await writeFile(
    `benchmarks/results/feed-import-${values.profile}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  session.close();
  target.cleanup();
}

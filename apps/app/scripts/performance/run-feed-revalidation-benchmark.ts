import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createFeedRevalidationWorkload } from "./feed-revalidation-workload";

const profiles = { small: 1000, representative: 10000, stress: 50000 };
const profile = process.argv[
  process.argv.indexOf("--profile") + 1
] as keyof typeof profiles;
if (!(profile in profiles))
  throw new Error("Pass --profile small, representative, or stress");
const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const workload = await createFeedRevalidationWorkload(
    session.database,
    profiles[profile],
  );
  const samples = [];
  for (let i = 0; i < 18; i++) {
    await workload.prepare();
    globalThis.gc?.();
    session.instrumentation.reset();
    const start = performance.now();
    await workload.run();
    const ms = performance.now() - start;
    const evidence = session.instrumentation.snapshot();
    if (
      evidence.statementCount > 20 ||
      evidence.materializedRows > 20 ||
      workload.reads > 3
    )
      throw new Error("Feed revalidation exceeded its work bounds");
    if (i >= 3)
      samples.push({
        ms,
        statements: evidence.statementCount,
        rows: evidence.materializedRows,
        sourceOperations: workload.reads,
      });
  }
  const ordered = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const result = {
    profile,
    historySize: profiles[profile],
    warmups: 3,
    repetitions: 15,
    medianMs: ordered[7],
    p95Ms: ordered[14],
    samples,
  };
  mkdirSync("benchmarks/results", { recursive: true });
  writeFileSync(
    `benchmarks/results/feed-revalidation-${profile}.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ ...result, samples: undefined }));
} finally {
  session.close();
  target.cleanup();
}

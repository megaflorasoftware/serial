import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createPageImageWorkload } from "./page-image-workload";
import { createIngestWorkload } from "./ingest-workload";

const profiles = { small: 1_000, representative: 10_000, stress: 50_000 };
const profile = process.argv[
  process.argv.indexOf("--profile") + 1
] as keyof typeof profiles;
if (!(profile in profiles))
  throw new Error("Pass --profile small, representative, or stress");
const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const workload = await createIngestWorkload(
    session.database,
    profiles[profile],
  );
  await workload.run(false);
  const results: Record<string, unknown> = {};
  for (const [name, changed] of [
    ["first-page-edits", true],
    ["unchanged-revision", false],
  ] as const) {
    const samples: Array<{
      ms: number;
      statements: number;
      rows: number;
      requests: number;
    }> = [];
    for (let i = 0; i < 18; i++) {
      globalThis.gc?.();
      session.instrumentation.reset();
      const started = performance.now();
      // Each sample measures an isolated operation against the preceding revision.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await workload.run(changed);
      const ms = performance.now() - started;
      const evidence = session.instrumentation.snapshot();
      if (i >= 3)
        samples.push({
          ms,
          statements: evidence.statementCount,
          rows: evidence.materializedRows,
          requests: workload.requests,
        });
    }
    const ordered = samples.map((sample) => sample.ms).sort((a, b) => a - b);
    results[name] = { medianMs: ordered[7], p95Ms: ordered[14], samples };
  }
  const pageImages = await createPageImageWorkload(session.database);
  const imageSamples = [];
  for (let i = 0; i < 18; i++) {
    // Prepare outside the timed operation.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await pageImages.prepare();
    globalThis.gc?.();
    session.instrumentation.reset();
    const started = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await pageImages.run();
    const ms = performance.now() - started;
    const evidence = session.instrumentation.snapshot();
    if (i >= 3)
      imageSamples.push({
        ms,
        statements: evidence.statementCount,
        rows: evidence.materializedRows,
        requests: pageImages.requests,
      });
  }
  const imageTimes = imageSamples
    .map((sample) => sample.ms)
    .sort((a, b) => a - b);
  results["page-image-repair"] = {
    medianMs: imageTimes[7],
    p95Ms: imageTimes[14],
    samples: imageSamples,
  };
  mkdirSync("benchmarks/results", { recursive: true });
  const output = `benchmarks/results/ingest-${profile}.json`;
  writeFileSync(
    output,
    JSON.stringify(
      {
        profile,
        historySize: profiles[profile],
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        warmups: 3,
        repetitions: 15,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      output,
      results: Object.fromEntries(
        Object.entries(results).map(([name, value]) => {
          const { medianMs, p95Ms } = value as {
            medianMs: number;
            p95Ms: number;
          };
          return [name, { medianMs, p95Ms }];
        }),
      ),
    }),
  );
} finally {
  session.close();
  target.cleanup();
}

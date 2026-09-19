import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createJetstreamWorkload } from "./jetstream-workload";
import { interruptStream } from "~/server/jetstream/store";

const profiles = {
  small: { fanout: 5, history: 1000 },
  representative: { fanout: 25, history: 10000 },
  stress: { fanout: 100, history: 50000 },
};
const profile = process.argv[
  process.argv.indexOf("--profile") + 1
] as keyof typeof profiles;
if (!(profile in profiles))
  throw new Error("Choose --profile small, representative, or stress");
const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const workload = await createJetstreamWorkload(
    session.database,
    profiles[profile].fanout,
    profiles[profile].history,
  );
  await workload.run("changed");
  const results: Record<string, unknown> = {};
  for (const mode of ["changed", "duplicate", "idle", "ineligible"] as const) {
    const samples = [];
    for (let index = 0; index < 7; index++) {
      session.instrumentation.reset();
      const started = performance.now();
      // Each sample depends on the previous revision and isolated instrumentation.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await workload.run(mode);
      const measurement = session.instrumentation.snapshot();
      const itemWrites = measurement.statements.filter((entry) =>
        /^(insert into|update|delete from) "serial_feed_item"/i.test(entry.sql),
      ).length;
      if (mode !== "changed" && itemWrites !== 0)
        throw new Error(`${mode} wrote reader items`);
      if (measurement.materializedRows > profiles[profile].fanout * 45 + 50)
        throw new Error("Unbounded stream query growth");
      samples.push({
        ms: performance.now() - started,
        statements: measurement.statementCount,
        rows: measurement.materializedRows,
        itemWrites,
        ...result,
      });
    }
    const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
    results[mode] = { medianMs: times[3], p95Ms: times[6], samples };
  }
  for (const mode of ["bootstrap", "direct-recovery"] as const) {
    const samples = [];
    for (let index = 0; index < 7; index++) {
      session.instrumentation.reset();
      const started = performance.now();
      // Reset counters and finish this recovery before measuring the next sample.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await workload.recover(mode === "bootstrap");
      const evidence = session.instrumentation.snapshot();
      if (
        result.pages > 2 ||
        result.images > 8 ||
        evidence.materializedRows > 1600
      )
        throw new Error("Unbounded direct recovery");
      samples.push({
        ms: performance.now() - started,
        rows: evidence.materializedRows,
        statements: evidence.statementCount,
        ...result,
      });
    }
    const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
    results[mode] = { medianMs: times[3], p95Ms: times[6], samples };
  }
  await workload.prepareHealthy();
  const healthy = [];
  for (let index = 0; index < 7; index++) {
    session.instrumentation.reset();
    const started = performance.now();
    // Each sample measures a single normal fetch against the same healthy stream.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await workload.check();
    const evidence = session.instrumentation.snapshot();
    healthy.push({
      ms: performance.now() - started,
      statements: evidence.statementCount,
      rows: evidence.materializedRows,
      ...result,
    });
  }
  const times = healthy.map((sample) => sample.ms).sort((a, b) => a - b);
  results["healthy-fetch"] = {
    medianMs: times[3],
    p95Ms: times[6],
    samples: healthy,
  };
  session.instrumentation.reset();
  const interruptionStarted = performance.now();
  await interruptStream(session.database, "benchmark", true);
  const interruption = session.instrumentation.snapshot();
  if (interruption.statementCount !== 1 || interruption.materializedRows !== 1)
    throw new Error("Interruption work must not scale with Feed count");
  results.interruption = {
    ms: performance.now() - interruptionStarted,
    statements: interruption.statementCount,
    rows: interruption.materializedRows,
  };
  mkdirSync("benchmarks/results", { recursive: true });
  writeFileSync(
    `benchmarks/results/jetstream-${profile}.json`,
    JSON.stringify({ profile, fixture: profiles[profile], results }, null, 2),
  );
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(results).map(([mode, result]) => [mode, result]),
      ),
      null,
      2,
    ),
  );
} finally {
  session.close();
  target.cleanup();
}

import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createJetstreamWorkload } from "./jetstream-workload";
import { declareStreamGap, disconnectStream } from "~/server/jetstream/store";

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
  /** One fixed-cost operation: its statements must not grow with the fixture. */
  async function fixedCost(
    name: string,
    budget: { statements: number; rows: number },
    operation: () => Promise<unknown>,
  ) {
    session.instrumentation.reset();
    const started = performance.now();
    await operation();
    const evidence = session.instrumentation.snapshot();
    if (
      evidence.statementCount !== budget.statements ||
      evidence.materializedRows !== budget.rows
    )
      throw new Error(`${name} statements must not scale with Feed count`);
    results[name] = {
      ms: performance.now() - started,
      statements: evidence.statementCount,
      rows: evidence.materializedRows,
    };
  }
  const intake = await workload.intake();
  // Network-wide traffic for publishers nobody follows never reaches the database.
  await fixedCost("skipped-event", { statements: 0, rows: 0 }, async () => {
    const { applied } = await intake.skip();
    if (applied !== 0) throw new Error("A skipped event was applied");
  });
  await fixedCost("intake-refresh", { statements: 1, rows: 0 }, intake.refresh);
  await fixedCost("idle-sweep", { statements: 1, rows: 0 }, workload.sweep);
  // Documents in backoff, or held by a paused origin, are none of the sweep's work.
  await workload.stageBacklog(profiles[profile].history);
  await fixedCost("backlog-sweep", { statements: 1, rows: 0 }, workload.sweep);
  await fixedCost("disconnect", { statements: 1, rows: 0 }, () =>
    disconnectStream(session.database, "benchmark"),
  );
  // The marker's write, then one statement for the covered origins.
  await fixedCost("gap", { statements: 2, rows: 1 }, () =>
    declareStreamGap(session.database, "benchmark", new Date()),
  );
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

import { mkdirSync, writeFileSync } from "node:fs";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createJetstreamWorkload } from "./jetstream-workload";

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

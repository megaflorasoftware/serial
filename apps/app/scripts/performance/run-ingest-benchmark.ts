import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { createObservationImageWorkload } from "./observation-image-workload";
import { createJetstreamWorkload } from "./jetstream-workload";
import { percentile } from "./model";
import {
  readsBehindItemBody,
  textIngestBudget,
  textIngestOverruns,
} from "./text-ingest-budgets";
import { createTextIngestWorkload } from "./text-ingest-workload";

const profiles = { small: 1_000, representative: 10_000, stress: 50_000 };
/** A feed document at the parser's item bound. */
const TEXT_FEED_ITEMS = 200;
const TEXT_FEED_EDITS = 3;
const profile = process.argv[
  process.argv.indexOf("--profile") + 1
] as keyof typeof profiles;
if (!(profile in profiles))
  throw new Error("Pass --profile small, representative, or stress");

/** The median and 95th percentile of an operation's timed samples. */
function timing(times: number[]) {
  return { medianMs: percentile(times, 0.5), p95Ms: percentile(times, 0.95) };
}

const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const workload = await createJetstreamWorkload(
    session.database,
    1,
    profiles[profile],
  );
  const results: Record<string, unknown> = {};
  for (const [name, bootstrap] of [
    ["repository-bootstrap", true],
    ["direct-recovery", false],
  ] as const) {
    const samples: Array<{
      ms: number;
      statements: number;
      rows: number;
      pages: number;
      images: number;
    }> = [];
    for (let i = 0; i < 18; i++) {
      globalThis.gc?.();
      session.instrumentation.reset();
      const started = performance.now();
      // Each sample measures staging and one bounded processing pass.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await workload.recover(bootstrap);
      const ms = performance.now() - started;
      const evidence = session.instrumentation.snapshot();
      if (i >= 3)
        samples.push({
          ms,
          statements: evidence.statementCount,
          rows: evidence.materializedRows,
          pages: result.pages,
          images: result.images,
        });
    }
    results[name] = {
      ...timing(samples.map((sample) => sample.ms)),
      samples,
    };
  }
  const pageImages = createObservationImageWorkload();
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
  results["observation-image-enrichment"] = {
    ...timing(imageSamples.map((sample) => sample.ms)),
    samples: imageSamples,
  };
  const textFeed = await createTextIngestWorkload(
    session.database,
    TEXT_FEED_ITEMS,
  );
  let unchangedStatements: string[] = [];
  for (const [name, operation, edits] of [
    ["text-fetch-unchanged", "unchanged", 0],
    ["text-fetch-changed", "changed", TEXT_FEED_EDITS],
  ] as const) {
    const budget = textIngestBudget(operation, TEXT_FEED_ITEMS, edits);
    const samples = [];
    for (let i = 0; i < 18; i++) {
      globalThis.gc?.();
      session.instrumentation.reset();
      const started = performance.now();
      // Each sample fetches the same document again, edited or not.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      const result = await textFeed.run(operation, edits);
      const ms = performance.now() - started;
      const evidence = session.instrumentation.snapshot();
      const overruns = [
        ...textIngestOverruns(budget, evidence),
        ...(result.written === edits ? [] : ["written items"]),
        ...(textFeed.pages > 0 ? ["page requests"] : []),
      ];
      if (overruns.length)
        throw new Error(
          `${name} exceeded its structural budget: ${overruns.join(", ")}`,
        );
      if (operation === "unchanged")
        unchangedStatements = evidence.statements.map((entry) => entry.sql);
      if (i >= 3)
        samples.push({
          ms,
          statements: evidence.statementCount,
          rows: evidence.materializedRows,
          written: result.written,
        });
    }
    results[name] = {
      ...timing(samples.map((sample) => sample.ms)),
      samples,
    };
  }
  // Programs are inspected after the writes: local libSQL EXPLAIN can retain a read lock.
  const behindBody = (
    await Promise.all(
      unchangedStatements.map((sql) =>
        readsBehindItemBody(session.baseClient, sql),
      ),
    )
  ).flat();
  if (behindBody.length)
    throw new Error(
      `text-fetch-unchanged read behind an item's body: ${behindBody.join(", ")}`,
    );
  // What every fetch pays before it reads an item: the digest of the parsed feed.
  for (const medium of ["text", "video"] as const) {
    const times = [];
    for (let i = 0; i < 18; i++) {
      globalThis.gc?.();
      const started = performance.now();
      textFeed.digest(medium);
      const ms = performance.now() - started;
      if (i >= 3) times.push(ms);
    }
    results[`feed-digest-${medium}`] = {
      ...timing(times),
      samples: times.map((ms) => ({ ms })),
    };
  }
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

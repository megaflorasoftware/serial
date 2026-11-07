import { mkdirSync, writeFileSync } from "node:fs";
import { recordPreview } from "@serial/standard-site";
import { createPublicationClient } from "../../src/server/rss/atprotoClient";

const uri = "at://did:plc:benchmark/site.standard.publication/site";
const record = {
  uri,
  cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  value: { name: "Benchmark", url: "https://site.example" },
};
const results = [];
for (const mode of ["healthy", "unavailable", "stalled"] as const) {
  const samples = [];
  for (let i = 0; i < 9; i++) {
    let requests = 0;
    let identityReads = 0;
    const client = createPublicationClient({
      resolvePds: async () => {
        identityReads++;
        return "https://pds.example";
      },
      resolveDidDocument: async () => {
        throw new Error("Unexpected DID document");
      },
      fetch: async (input) => {
        requests++;
        const url = new URL(String(input));
        if (url.origin !== "https://pds.example") {
          if (mode === "unavailable")
            return new Response(null, { status: 503 });
          if (mode === "stalled") return new Promise(() => {});
        }
        return Response.json(record);
      },
    });
    const start = performance.now();
    // Measure the conversion caller and its per-refresh coalescing, including fallback.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const records = await Promise.all([
      client.getRecord(uri, { deadline: Date.now() + 5_000 }),
      client.getRecord(uri, { deadline: Date.now() + 5_000 }),
    ]);
    const cards = records.map((value) =>
      recordPreview(uri, (target) => (target === uri ? value : undefined)),
    );
    const ms = performance.now() - start;
    if (cards.some((card) => card?.title !== "Benchmark"))
      throw new Error("Missing record card");
    if (requests !== (mode === "healthy" ? 1 : 2))
      throw new Error("Unexpected request count");
    if (identityReads !== (mode === "healthy" ? 0 : 1))
      throw new Error("Unexpected identity reads");
    if (ms > (mode === "stalled" ? 1_500 : 250))
      throw new Error(`Lookup exceeded budget: ${ms} ms`);
    if (i >= 2) samples.push({ ms, requests, identityReads });
  }
  const times = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  results.push({ mode, medianMs: times[3], p95Ms: times[6], samples });
}
mkdirSync("benchmarks/results", { recursive: true });
writeFileSync(
  "benchmarks/results/public-record.json",
  JSON.stringify(results, null, 2),
);
console.log(
  results.map(({ mode, medianMs, p95Ms }) => ({ mode, medianMs, p95Ms })),
);

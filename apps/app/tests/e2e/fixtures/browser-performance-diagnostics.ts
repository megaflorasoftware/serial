import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession } from "@playwright/test";

/** Optional CPU evidence; ordinary budget runs do not enable tracing. */
export async function startBrowserPerformanceDiagnostics(client: CDPSession) {
  if (process.env.SERIAL_CLIENT_PERFORMANCE_DIAGNOSTICS !== "1") {
    return async () => {};
  }
  await client.send("Profiler.enable");
  await client.send("Profiler.start");
  await client.send("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing",
    transferMode: "ReturnAsStream",
  });
  return async () => {
    const output = path.resolve("benchmarks/results/browser-diagnostics");
    await mkdir(output, { recursive: true });
    const { profile } = await client.send("Profiler.stop");
    await writeFile(
      path.join(output, "cpu.cpuprofile"),
      JSON.stringify(profile),
    );
    const complete = new Promise<string>((resolve) => {
      client.once("Tracing.tracingComplete", ({ stream }) => resolve(stream!));
    });
    await client.send("Tracing.end");
    const stream = await complete;
    const chunks: string[] = [];
    try {
      for (;;) {
        const chunk = await client.send("IO.read", { handle: stream });
        chunks.push(chunk.data);
        if (chunk.eof) break;
      }
      await writeFile(path.join(output, "timeline.json"), chunks.join(""));
    } finally {
      await client.send("IO.close", { handle: stream });
      await client.send("Profiler.disable");
    }
  };
}

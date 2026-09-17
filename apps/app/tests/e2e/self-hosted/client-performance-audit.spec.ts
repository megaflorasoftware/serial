import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { format } from "prettier";
import { startBrowserPerformanceDiagnostics } from "../fixtures/browser-performance-diagnostics";
import { SELF_HOSTED_TURSO_PORT } from "../fixtures/ports";
import { cleanupUser, seedClientPerformanceData } from "../fixtures/seed-db";
import { signIn } from "../fixtures/auth";
import {
  CLIENT_BROWSER_BUDGETS,
  evaluateClientBrowserScenario,
  summarizePercentiles,
} from "../../../scripts/performance/client-browser-budgets";
import type { Page } from "@playwright/test";

test.skip(
  process.env.SERIAL_RUN_CLIENT_PERFORMANCE !== "1",
  "manual retained browser-performance evidence",
);
test.describe.configure({ mode: "serial", timeout: 180_000 });

type BrowserMetrics = {
  durationMs: number;
  usableContentMs: number | null;
  longTasks: number[];
  commits: Array<{ actualDuration: number; baseDuration: number }>;
  indexedDb: {
    reads: number;
    writes: number;
    writesByStore: Record<string, number>;
  };
  requests: number;
  transferBytes: number;
  rpcRequests: number;
  rpcTransferBytes: number;
  heapBytes: number | null;
  storageBytes: number | null;
  marks: Array<{ name: string; startTime: number }>;
};

type PerformanceWindow = Window & {
  __SERIAL_CLIENT_PERFORMANCE__?: {
    commits: Array<{ actualDuration: number; baseDuration: number }>;
    readyForWarmReload: () => Promise<void>;
  };
};

type NetworkMetrics = {
  requests: number;
  transferBytes: number;
  rpcRequests: number;
  rpcTransferBytes: number;
  rpcPaths: string[];
};

async function installObservers(page: Page) {
  const diagnosticsEnabled =
    process.env.SERIAL_CLIENT_PERFORMANCE_DIAGNOSTICS === "1";
  await page.addInitScript((collectDiagnostics) => {
    const metrics = {
      longTasks: [] as number[],
      indexedDb: {
        reads: 0,
        writes: 0,
        writesByStore: {} as Record<string, number>,
      },
    };
    Object.defineProperty(window, "__SERIAL_BROWSER_AUDIT__", {
      value: metrics,
      configurable: true,
    });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        metrics.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });

    const objectStore = IDBObjectStore.prototype;
    const get = objectStore.get;
    const put = objectStore.put;
    objectStore.get = function (...args) {
      metrics.indexedDb.reads++;
      return get.apply(this, args);
    };
    objectStore.put = collectDiagnostics
      ? function (this: IDBObjectStore, ...args) {
          metrics.indexedDb.writes++;
          const store = String(args[1]).replace(
            /(::record:[^:]+:|::array:[^:]+:).*$/,
            "$1",
          );
          metrics.indexedDb.writesByStore[store] =
            (metrics.indexedDb.writesByStore[store] ?? 0) + 1;
          return put.apply(this, args);
        }
      : function (this: IDBObjectStore, ...args) {
          metrics.indexedDb.writes++;
          return put.apply(this, args);
        };
  }, diagnosticsEnabled);
}

async function resetBrowserMetrics(page: Page) {
  await page.evaluate(() => {
    const audit = (
      window as typeof window & {
        __SERIAL_BROWSER_AUDIT__: {
          longTasks: number[];
          indexedDb: {
            reads: number;
            writes: number;
            writesByStore: Record<string, number>;
          };
        };
      }
    ).__SERIAL_BROWSER_AUDIT__;
    audit.longTasks = [];
    audit.indexedDb = { reads: 0, writes: 0, writesByStore: {} };
    const performanceWindow = window as PerformanceWindow;
    if (performanceWindow.__SERIAL_CLIENT_PERFORMANCE__) {
      performanceWindow.__SERIAL_CLIENT_PERFORMANCE__.commits = [];
    }
    performance.clearMarks();
  });
}

async function collectMetrics(
  page: Page,
  inputStartedAt: number,
  network: NetworkMetrics,
  inputUsableContentMs: number | null = null,
): Promise<BrowserMetrics> {
  return page.evaluate(
    async ({
      startedAt,
      requests,
      transferBytes,
      rpcRequests,
      rpcTransferBytes,
      rpcPaths,
      usableContentMs,
    }) => {
      const audit = (
        window as typeof window & {
          __SERIAL_BROWSER_AUDIT__: {
            longTasks: number[];
            indexedDb: {
              reads: number;
              writes: number;
              writesByStore: Record<string, number>;
            };
          };
          performance: Performance & {
            memory?: { usedJSHeapSize: number };
          };
        }
      ).__SERIAL_BROWSER_AUDIT__;
      const storageEstimate = await navigator.storage.estimate();
      return {
        durationMs: performance.now() - startedAt,
        usableContentMs,
        longTasks: audit.longTasks,
        commits:
          (
            window as PerformanceWindow
          ).__SERIAL_CLIENT_PERFORMANCE__?.commits.map(
            ({ actualDuration, baseDuration }) => ({
              actualDuration,
              baseDuration,
            }),
          ) ?? [],
        indexedDb: audit.indexedDb,
        requests,
        transferBytes,
        rpcRequests,
        rpcTransferBytes,
        rpcPaths,
        heapBytes:
          (
            window.performance as Performance & {
              memory?: { usedJSHeapSize: number };
            }
          ).memory?.usedJSHeapSize ?? null,
        storageBytes: storageEstimate.usage ?? null,
        marks: performance
          .getEntriesByType("mark")
          .filter(({ name }) => name.startsWith("serial:"))
          .map(({ name, startTime }) => ({ name, startTime })),
      };
    },
    {
      startedAt: inputStartedAt,
      usableContentMs: inputUsableContentMs,
      ...network,
    },
  );
}

async function clearPersistedClientState(page: Page) {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keyval", "readwrite");
      transaction.objectStore("keyval").clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

async function measureColdLoad(
  page: Page,
  network: NetworkMetrics,
  resetNetwork: () => void,
) {
  await clearPersistedClientState(page);
  resetNetwork();
  await page.goto("/?client-performance-audit=1");
  await expect(page.getByText(/Fixture item \d+/).first()).toBeVisible({
    timeout: 120_000,
  });
  const usableContentMs = await page.evaluate(() => performance.now());
  await page.waitForTimeout(2_200);
  return collectMetrics(page, 0, network, usableContentMs);
}

async function measureWarmHydration(
  page: Page,
  network: NetworkMetrics,
  resetNetwork: () => void,
) {
  await page.waitForFunction(() =>
    performance
      .getEntriesByType("mark")
      .some(({ name }) => name === "serial:server-parity-applied"),
  );
  await page.evaluate(async () => {
    const readiness = (window as PerformanceWindow)
      .__SERIAL_CLIENT_PERFORMANCE__?.readyForWarmReload;
    if (!readiness) throw new Error("Client performance readiness is missing");
    await readiness();
  });
  await resetBrowserMetrics(page);
  resetNetwork();
  await page.reload();
  await expect(page.getByText(/Fixture item \d+/).first()).toBeVisible({
    timeout: 120_000,
  });
  const usableContentMs = await page.evaluate(() => performance.now());
  await page.waitForTimeout(2_200);
  return collectMetrics(page, 0, network, usableContentMs);
}

test("profiles representative cold load, warm hydration, reconnect, pagination, and reader rendering", async ({
  page,
}) => {
  const profile = "representative" as const;
  const { email, password } = await seedClientPerformanceData(
    SELF_HOSTED_TURSO_PORT,
    profile,
  );
  await installObservers(page);

  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  const diagnosticsEnabled =
    process.env.SERIAL_CLIENT_PERFORMANCE_DIAGNOSTICS === "1";
  const network = {
    requests: 0,
    transferBytes: 0,
    rpcRequests: 0,
    rpcTransferBytes: 0,
    rpcPaths: [] as string[],
  };
  const rpcRequestIds = new Set<string>();
  client.on("Network.requestWillBeSent", ({ requestId, request }) => {
    network.requests++;
    if (request.url.includes("/api/rpc")) {
      network.rpcRequests++;
      if (diagnosticsEnabled) {
        network.rpcPaths.push(new URL(request.url).pathname);
      }
      rpcRequestIds.add(requestId);
    }
  });
  client.on("Network.dataReceived", ({ requestId, encodedDataLength }) => {
    network.transferBytes += encodedDataLength;
    if (rpcRequestIds.has(requestId)) {
      network.rpcTransferBytes += encodedDataLength;
    }
  });

  const resetNetwork = () => {
    network.requests = 0;
    network.transferBytes = 0;
    network.rpcRequests = 0;
    network.rpcTransferBytes = 0;
    network.rpcPaths = [];
    rpcRequestIds.clear();
  };

  const stopDiagnostics = await startBrowserPerformanceDiagnostics(client);
  try {
    await signIn({ page, email, password });
    const firstFixtureItem = page.getByText(/Fixture item \d+/).first();
    await expect(firstFixtureItem).toBeVisible({
      timeout: 120_000,
    });
    await page.waitForTimeout(2_200);
    const coldLoad = await measureColdLoad(page, network, resetNetwork);
    const warmHydration = await measureWarmHydration(
      page,
      network,
      resetNetwork,
    );
    const coldSamples = [coldLoad];
    const warmSamples = [warmHydration];
    const percentileSampleCount = Math.max(
      1,
      Number(process.env.SERIAL_CLIENT_PERFORMANCE_SAMPLES ?? 5),
    );
    for (let sample = 1; sample < percentileSampleCount; sample++) {
      coldSamples.push(await measureColdLoad(page, network, resetNetwork));
      warmSamples.push(await measureWarmHydration(page, network, resetNetwork));
    }

    await resetBrowserMetrics(page);
    resetNetwork();
    const reconnectStartedAt = await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      return performance.now();
    });
    await page.waitForTimeout(3_000);
    const reconnect = await collectMetrics(page, reconnectStartedAt, network);

    await resetBrowserMetrics(page);
    resetNetwork();
    const paginationStartedAt = await page.evaluate(() => performance.now());
    await page.locator('[data-slot="sidebar-inset"]').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(2_000);
    const pagination = await collectMetrics(page, paginationStartedAt, network);

    await resetBrowserMetrics(page);
    resetNetwork();
    const readerStartedAt = await page.evaluate(() => performance.now());
    await page
      .getByText(/Fixture item \d+/)
      .first()
      .click({ timeout: 30_000 });
    await expect(page.getByText(/Fixture body \d+/)).toBeVisible({
      timeout: 30_000,
    });
    const readerUsableContentMs = await page.evaluate(
      (startedAt) => performance.now() - startedAt,
      readerStartedAt,
    );
    const reader = await collectMetrics(
      page,
      readerStartedAt,
      network,
      readerUsableContentMs,
    );

    await page.goto(`/?client-performance-audit=1`);
    await page
      .getByRole("radio", { name: "All benchmark content", exact: true })
      .click();
    await expect(
      page.getByText("Fixture page capture", { exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(2_200);
    await resetBrowserMetrics(page);
    resetNetwork();
    const pageCaptureReaderStartedAt = await page.evaluate(() =>
      performance.now(),
    );
    await page
      .getByText("Fixture page capture", { exact: true })
      .click({ timeout: 30_000 });
    await expect(page.getByText("Captured performance body 100.")).toBeVisible({
      timeout: 30_000,
    });
    const pageCaptureReaderUsableContentMs = await page.evaluate(
      (startedAt) => performance.now() - startedAt,
      pageCaptureReaderStartedAt,
    );
    const pageCaptureReader = await collectMetrics(
      page,
      pageCaptureReaderStartedAt,
      network,
      pageCaptureReaderUsableContentMs,
    );

    const productionProfile =
      process.env.SERIAL_CLIENT_PERFORMANCE_PRODUCTION === "1";
    const artifact = {
      generatedAt: new Date().toISOString(),
      environment: productionProfile
        ? "local-self-hosted-production-chromium"
        : "local-self-hosted-development-chromium",
      profile,
      coldLoad,
      warmHydration,
      coldWarmSamples: {
        coldLoad: coldSamples,
        warmHydration: warmSamples,
      },
      coldWarmPercentiles: {
        coldUsableContentMs: summarizePercentiles(
          coldSamples.flatMap(({ usableContentMs }) =>
            usableContentMs === null ? [] : [usableContentMs],
          ),
        ),
        coldServerParityMs: summarizePercentiles(
          coldSamples.flatMap(({ marks }) =>
            marks
              .filter(({ name }) => name === "serial:server-parity-applied")
              .map(({ startTime }) => startTime)
              .slice(-1),
          ),
        ),
        warmUsableContentMs: summarizePercentiles(
          warmSamples.flatMap(({ usableContentMs }) =>
            usableContentMs === null ? [] : [usableContentMs],
          ),
        ),
        warmServerParityMs: summarizePercentiles(
          warmSamples.flatMap(({ marks }) =>
            marks
              .filter(({ name }) => name === "serial:server-parity-applied")
              .map(({ startTime }) => startTime)
              .slice(-1),
          ),
        ),
      },
      reconnect,
      pagination,
      reader,
      pageCaptureReader,
    };
    const output = path.resolve(
      productionProfile
        ? "benchmarks/results/browser-client-representative.json"
        : "benchmarks/results/browser-client-development-representative.json",
    );
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      output,
      await format(JSON.stringify(artifact), { parser: "json" }),
      "utf8",
    );
    if (productionProfile) {
      const repeatedLoadViolations = [
        ...coldSamples.flatMap((metrics, index) =>
          evaluateClientBrowserScenario("coldLoad", metrics).map(
            (violation) => `coldLoad sample ${index + 1}: ${violation}`,
          ),
        ),
        ...warmSamples.flatMap((metrics, index) =>
          evaluateClientBrowserScenario("warmHydration", metrics).map(
            (violation) => `warmHydration sample ${index + 1}: ${violation}`,
          ),
        ),
      ];
      const singleScenarioViolations = Object.keys(CLIENT_BROWSER_BUDGETS)
        .filter(
          (scenario) => scenario !== "coldLoad" && scenario !== "warmHydration",
        )
        .flatMap((scenario) =>
          evaluateClientBrowserScenario(
            scenario as keyof typeof CLIENT_BROWSER_BUDGETS,
            artifact[scenario as keyof typeof CLIENT_BROWSER_BUDGETS],
          ).map((violation) => `${scenario}: ${violation}`),
        );
      const violations = [
        ...repeatedLoadViolations,
        ...singleScenarioViolations,
      ];
      expect(violations, "production browser performance budgets").toEqual([]);
    }
  } finally {
    await stopDiagnostics();
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

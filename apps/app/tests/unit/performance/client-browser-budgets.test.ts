import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CLIENT_BROWSER_BUDGETS,
  evaluateClientBrowserScenario,
  summarizePercentiles,
} from "../../../scripts/performance/client-browser-budgets";

describe("client browser performance budgets", () => {
  it("keeps the retained representative production-browser profile in budget", async () => {
    const baselines = JSON.parse(
      await readFile(
        new URL(
          "../../fixtures/performance/budget-baselines.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      browser: Record<
        string,
        Parameters<typeof evaluateClientBrowserScenario>[1]
      >;
    };
    const violations = Object.keys(CLIENT_BROWSER_BUDGETS).flatMap((scenario) =>
      evaluateClientBrowserScenario(
        scenario as keyof typeof CLIENT_BROWSER_BUDGETS,
        baselines.browser[scenario]!,
      ).map((violation) => `${scenario}: ${violation}`),
    );

    expect(violations).toEqual([]);
  });

  it("reports each enforced measurement", () => {
    const violations = evaluateClientBrowserScenario("reader", {
      usableContentMs: null,
      longTasks: [CLIENT_BROWSER_BUDGETS.reader.longTaskMs + 1],
      commits: [
        { actualDuration: CLIENT_BROWSER_BUDGETS.reader.reactCommitMs + 1 },
      ],
      indexedDb: {
        reads: Number.POSITIVE_INFINITY,
        writes: Number.POSITIVE_INFINITY,
      },
      requests: Number.POSITIVE_INFINITY,
      transferBytes: Number.POSITIVE_INFINITY,
      rpcRequests: Number.POSITIVE_INFINITY,
      rpcTransferBytes: Number.POSITIVE_INFINITY,
      heapBytes: null,
      storageBytes: null,
    });

    expect(violations).toHaveLength(11);
  });

  it("reports local p50 and p95 without creating a timing gate", () => {
    expect(summarizePercentiles([100, 50, 400, 200, 300])).toEqual({
      samples: 5,
      p50: 200,
      p95: 400,
    });
  });

  it("retains a one-MiB ceiling for the finite full-matrix repair", () => {
    const fullMatrixTransfer = 900 * 1_024;
    const metrics = {
      usableContentMs: 200,
      longTasks: [],
      commits: [],
      indexedDb: { reads: 0, writes: 0 },
      requests: 2,
      transferBytes: fullMatrixTransfer,
      rpcRequests: 1,
      rpcTransferBytes: fullMatrixTransfer,
      heapBytes: 32 * 1_024 * 1_024,
      storageBytes: 8 * 1_024 * 1_024,
    };

    expect(evaluateClientBrowserScenario("warmHydration", metrics)).toEqual([]);
    expect(
      evaluateClientBrowserScenario("reconnect", {
        ...metrics,
        usableContentMs: null,
      }),
    ).toEqual([]);
  });
});

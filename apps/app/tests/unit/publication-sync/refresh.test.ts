import { describe, expect, it, vi } from "vitest";
import type { db as Database } from "~/server/db";
import { syncBeforeFeedRefresh } from "~/server/publication-sync/refresh";
import { fetchDueSources } from "~/server/rss/fetchDueSources";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";

describe("pre-refresh subscription sync", () => {
  it("starts the winner's lifecycle before subscription work and only then loads due Feeds", async () => {
    const order: string[] = [];
    const publish = vi.fn(async (_channel, chunk) => {
      order.push(chunk.type);
    });
    const result = await fetchDueSources({
      database: {} as typeof Database,
      userId: "owner",
      trigger: "automatic",
      channel: "user:owner",
      publish,
      dependencies: {
        resolveOwner: async () => "client",
        claimUser: async () => {
          order.push("claim");
          return { eligible: true, nextRefreshAt: new Date() };
        },
        syncSubscriptions: async (input) => {
          order.push("sync");
          await input.onProgress?.({ runId: "run", completed: 0, total: 1 });
          order.push("import");
          return { ...emptyPublicationSyncCounts(), status: "completed" };
        },
        countDue: async () => {
          order.push("count");
          return 0;
        },
        getDuePage: async () => [],
      },
    });
    expect(result.status).toBe("completed");
    expect(order).toEqual([
      "claim",
      "sync",
      "refresh-start",
      "refresh-progress",
      "import",
      "count",
      "refresh-progress",
      "rss-attempt-complete",
    ]);
  });
  it("allows normal item refresh after an unexpected sync failure", async () => {
    const result = await syncBeforeFeedRefresh({
      database: {} as typeof Database,
      userId: "owner",
      channel: "user:owner",
      nextRefreshAt: new Date(),
      publish: vi.fn(),
      sync: async () => {
        throw new Error("connection failure");
      },
    });
    expect(result).toBe(false);
  });
});

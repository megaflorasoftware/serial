import { describe, expect, it, vi } from "vitest";
import type { db as Database } from "~/server/db";
import type { FetchableOrigin } from "~/server/rss/types";
import type { RssPublishedChunk } from "~/lib/rss";
import { emptyRefreshStats } from "~/server/rss/stats";
import { fetchDueSources } from "~/server/rss/fetchDueSources";

const database = {} as typeof Database;
const nextRefreshAt = new Date("2026-08-10T12:05:00.000Z");

function baseInput() {
  const chunks: RssPublishedChunk[] = [];
  return {
    chunks,
    input: {
      database,
      userId: "user-1",
      trigger: "automatic" as const,
      channel: "user:user-1",
      publish: vi.fn((_channel: string, chunk: RssPublishedChunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      }),
    },
  };
}

describe("fetchDueSources", () => {
  it("does not claim or publish when the background task owns automatic RSS", async () => {
    const { input, chunks } = baseInput();
    const claimUser = vi.fn();

    await expect(
      fetchDueSources({
        ...input,
        dependencies: {
          resolveOwner: () => Promise.resolve("background-task"),
          claimUser,
        },
      }),
    ).resolves.toEqual({ status: "background-managed" });
    expect(claimUser).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
  });

  it("returns cooldown without emitting a losing lifecycle", async () => {
    const { input, chunks } = baseInput();

    await expect(
      fetchDueSources({
        ...input,
        dependencies: {
          resolveOwner: () => Promise.resolve("client"),
          claimUser: () => Promise.resolve({ eligible: false, nextRefreshAt }),
        },
      }),
    ).resolves.toEqual({ status: "cooldown", nextRefreshAt });
    expect(chunks).toEqual([]);
  });

  it("emits one winner-owned summary and preserves partial committed writes", async () => {
    const { input, chunks } = baseInput();
    let page = 0;
    const firstPageStats = {
      ...emptyRefreshStats(),
      refreshedCount: 1,
      totalRowsWritten: 2,
      affectedFeeds: [
        { feedId: 7, contentStatusKeys: ["inbox:unread" as const] },
      ],
    };
    const secondPageStats = {
      ...emptyRefreshStats(),
      errorCount: 1,
      originFailureFeedIds: [8],
    };
    const refreshFeedPage = vi
      .fn()
      .mockResolvedValueOnce(firstPageStats)
      .mockResolvedValueOnce(secondPageStats);

    const result = await fetchDueSources({
      ...input,
      dependencies: {
        resolveOwner: () => Promise.resolve("client"),
        claimUser: () => Promise.resolve({ eligible: true, nextRefreshAt }),
        countDue: () => Promise.resolve(2),
        getDuePage: () =>
          Promise.resolve(
            page < 2
              ? ([{ origin: { id: 7 + page++ } }] as FetchableOrigin[])
              : [],
          ),
        refreshFeedPage,
      },
    });

    expect(result.status).toBe("partial");
    expect(refreshFeedPage).toHaveBeenCalledTimes(2);
    expect(chunks.map(({ type }) => type)).toEqual([
      "refresh-start",
      "rss-attempt-complete",
    ]);
    expect(chunks.at(-1)).toMatchObject({
      type: "rss-attempt-complete",
      outcome: "partial",
      affectedFeeds: firstPageStats.affectedFeeds,
      originFailureFeedIds: [8],
    });
  });

  it("closes the winner lifecycle before surfacing an orchestration failure", async () => {
    const { input, chunks } = baseInput();
    let page = 0;

    await expect(
      fetchDueSources({
        ...input,
        dependencies: {
          resolveOwner: () => Promise.resolve("client"),
          claimUser: () => Promise.resolve({ eligible: true, nextRefreshAt }),
          countDue: () => Promise.resolve(1),
          getDuePage: () =>
            Promise.resolve(
              page++ === 0
                ? ([{ origin: { id: 7 } }] as FetchableOrigin[])
                : [],
            ),
          refreshFeedPage: () => Promise.reject(new Error("database failed")),
        },
      }),
    ).rejects.toThrow("database failed");
    expect(chunks.at(-1)).toMatchObject({
      type: "rss-attempt-complete",
      outcome: "failed",
    });
  });
});

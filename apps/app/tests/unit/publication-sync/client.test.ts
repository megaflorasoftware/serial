import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadingActor } from "~/lib/data/loading-machine";
import { requestPublicationSync } from "~/lib/data/publication-sync";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: { atproto: { syncSubscriptions: mocks.sync } },
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, warning: mocks.warning },
}));
beforeEach(() => {
  vi.clearAllMocks();
  loadingActor.send({ type: "RESET" });
});
describe("client publication sync", () => {
  it("coalesces sync requests, owns importing progress, and reports partial success", async () => {
    let finish!: (value: unknown) => void;
    mocks.sync.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = requestPublicationSync();
    const second = requestPublicationSync();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(loadingActor.getSnapshot().matches("importing")).toBe(true);
    finish({
      ...emptyPublicationSyncCounts(),
      status: "partial",
      imported: 2,
      failed: 1,
    });
    await first;
    expect(loadingActor.getSnapshot().matches("idle")).toBe(true);
    expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("2 imported"),
    );
    expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("1 failed"),
    );
  });
  it("waits for an ordinary Feed import without replacing its progress", async () => {
    loadingActor.send({ type: "IMPORT_START", totalFeeds: 9 });
    mocks.sync.mockResolvedValue({
      ...emptyPublicationSyncCounts(),
      status: "completed",
    });
    const pending = requestPublicationSync();
    await Promise.resolve();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(loadingActor.getSnapshot().context.totalFeeds).toBe(9);
    loadingActor.send({ type: "IMPORT_COMPLETE" });
    await pending;
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
  it("releases loading on a failed request so the user can retry", async () => {
    mocks.sync
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        ...emptyPublicationSyncCounts(),
        status: "completed",
      });
    await requestPublicationSync();
    expect(loadingActor.getSnapshot().matches("idle")).toBe(true);
    expect(mocks.error).toHaveBeenCalledWith("Network unavailable");
    await requestPublicationSync();
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });
});

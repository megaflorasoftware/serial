import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadingActor } from "~/lib/data/loading-machine";
import {
  PUBLICATION_SYNC_TOAST,
  refreshPublicationSyncProgress,
  showPublicationSyncProgress,
} from "~/lib/data/publication-sync";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";

const mocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
  status: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mocks }));
vi.mock("~/lib/orpc", () => ({
  orpc: {
    atproto: {
      getSyncStatus: {
        queryKey: () => ["sync-status"],
        queryOptions: (options: Record<string, unknown>) => ({
          ...options,
          queryKey: ["sync-status"],
          queryFn: mocks.status,
        }),
      },
    },
  },
}));
const clients: QueryClient[] = [];
const client = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(queryClient);
  return queryClient;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockReset();
  loadingActor.send({ type: "RESET" });
});
afterEach(() => {
  clients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
});

it.each(["completed", "partial"] as const)(
  "reports a %s run that finished before its first status read",
  async (status) => {
    mocks.status.mockResolvedValue({
      runId: "fast-run",
      pending: false,
      progress: null,
      result: {
        ...emptyPublicationSyncCounts(),
        status,
        exported: 2,
        failed: status === "partial" ? 1 : 0,
      },
    });
    await refreshPublicationSyncProgress(client());
    expect(
      status === "partial" ? mocks.warning : mocks.success,
    ).toHaveBeenCalledWith(
      expect.stringContaining("2 exported"),
      expect.objectContaining({ id: PUBLICATION_SYNC_TOAST }),
    );
  },
);

it("leaves a pending run in the query cache for the mounted progress observer", async () => {
  const job = { runId: "pending", pending: true, progress: null, result: null };
  mocks.status.mockResolvedValue(job);
  const queryClient = client();
  await refreshPublicationSyncProgress(queryClient);
  expect(queryClient.getQueryData(["sync-status"])).toEqual(job);
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.warning).not.toHaveBeenCalled();
});

it("does not replay cached completion when the fresh status read fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const queryClient = client();
  queryClient.setQueryData(["sync-status"], {
    runId: "old-run",
    pending: false,
    result: { ...emptyPublicationSyncCounts(), status: "completed" },
  });
  mocks.status.mockRejectedValue(new Error("offline"));
  await refreshPublicationSyncProgress(queryClient);
  expect(mocks.status).toHaveBeenCalledOnce();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.warning).not.toHaveBeenCalled();
});
it("tracks server work without blocking a concurrent Feed import", () => {
  loadingActor.send({ type: "IMPORT_START", totalFeeds: 9 });
  showPublicationSyncProgress({
    runId: "run",
    pending: true,
    progress: { completed: 2, total: 8 },
    result: null,
  });
  expect(loadingActor.getSnapshot().context.totalFeeds).toBe(9);
  expect(mocks.loading).toHaveBeenCalledWith(
    "Syncing subscriptions: 2 of 8",
    expect.objectContaining({ id: PUBLICATION_SYNC_TOAST }),
  );
  showPublicationSyncProgress({
    runId: "run",
    pending: false,
    progress: null,
    result: {
      ...emptyPublicationSyncCounts(),
      status: "partial",
      imported: 2,
      failed: 1,
    },
  });
  expect(mocks.warning).toHaveBeenCalledWith(
    expect.stringContaining("2 imported"),
    expect.objectContaining({ id: PUBLICATION_SYNC_TOAST }),
  );
  expect(loadingActor.getSnapshot().context.totalFeeds).toBe(9);
});

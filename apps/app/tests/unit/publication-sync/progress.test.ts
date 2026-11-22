// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicationSyncJobStatus } from "~/lib/auth/publication-sync";
import { PublicationSyncProgress } from "~/components/connections/PublicationSyncProgress";
import { notifyPublicationSyncStatusChanged } from "~/lib/data/publication-sync";
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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const settled: PublicationSyncJobStatus = {
  runId: "request",
  pending: false,
  running: false,
  progress: null,
  result: { ...emptyPublicationSyncCounts(), status: "completed", imported: 1 },
};
const inFlight: PublicationSyncJobStatus = {
  runId: "request",
  pending: true,
  running: true,
  progress: { completed: 1, total: 4 },
  result: null,
};
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;
async function mount() {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(PublicationSyncProgress),
      ),
    );
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.status.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  vi.useRealTimers();
});

it("neither polls nor announces a settled request, whatever runs in the background", async () => {
  mocks.status.mockResolvedValue(settled);
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(mocks.status).toHaveBeenCalledTimes(1);
  expect(mocks.loading).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.warning).not.toHaveBeenCalled();
});

it("reads the status again when the server announces a change", async () => {
  mocks.status.mockResolvedValue(inFlight);
  await mount();
  expect(mocks.loading).toHaveBeenCalledWith(
    "Syncing subscriptions: 1 of 4",
    expect.anything(),
  );
  mocks.status.mockResolvedValue(settled);
  await act(async () => {
    notifyPublicationSyncStatusChanged();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.status).toHaveBeenCalledTimes(2);
  expect(mocks.success).toHaveBeenCalledWith(
    expect.stringContaining("1 imported"),
    expect.anything(),
  );
  // Settled: later announcements still refetch, but nothing polls.
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(mocks.status).toHaveBeenCalledTimes(2);
});

it("falls back to a slow poll only while a request is in flight", async () => {
  mocks.status.mockResolvedValue(inFlight);
  await mount();
  await act(async () => vi.advanceTimersByTimeAsync(14_000));
  expect(mocks.status).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(mocks.status).toHaveBeenCalledTimes(2);
});

it("stops listening for announcements once unmounted", async () => {
  mocks.status.mockResolvedValue(settled);
  await mount();
  await act(async () => root.unmount());
  root = createRoot(document.createElement("div"));
  await act(async () => {
    notifyPublicationSyncStatusChanged();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(mocks.status).toHaveBeenCalledTimes(1);
});

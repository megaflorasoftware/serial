import { beforeEach, expect, it, vi } from "vitest";
import { loadingActor } from "~/lib/data/loading-machine";
import {
  PUBLICATION_SYNC_TOAST,
  showPublicationSyncProgress,
} from "~/lib/data/publication-sync";
import { emptyPublicationSyncCounts } from "~/lib/auth/publication-sync";

const mocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mocks }));
beforeEach(() => {
  vi.clearAllMocks();
  loadingActor.send({ type: "RESET" });
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

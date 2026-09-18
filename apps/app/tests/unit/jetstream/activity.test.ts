// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppActivity } from "~/lib/hooks/useAppActivity";

const mocks = vi.hoisted(() => ({
  id: "reader",
  record: vi.fn(),
  catchUp: vi.fn(),
}));
vi.mock("~/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: mocks.id } } }),
}));
vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: {
    user: { recordActivity: mocks.record, catchUpFeeds: mocks.catchUp },
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function Layout({
  loading = false,
  route = "/",
}: {
  loading?: boolean;
  route?: string;
}) {
  useAppActivity();
  if (loading) return "Loading";
  return route;
}
async function render(loading = false, route = "/") {
  await act(async () =>
    root.render(
      createElement(StrictMode, {}, createElement(Layout, { loading, route })),
    ),
  );
}
beforeEach(() => {
  root = createRoot(document.createElement("div"));
  mocks.id = "reader";
  mocks.record.mockResolvedValue(undefined);
  mocks.catchUp.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("authenticated layout activity", () => {
  it("records once through effect setup repetition, checkout loading and child-route navigation", async () => {
    await render(true);
    await render(false);
    await render(false, "/feeds");
    await render(false, "/views");
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.catchUp).toHaveBeenCalledTimes(1);
  });
  it("keeps rendering usable and orders catch-up after the activity write", async () => {
    let finish!: () => void;
    mocks.record.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    expect(mocks.catchUp).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    expect(mocks.catchUp).toHaveBeenCalledTimes(1);
  });
  it("starts a new operation for account changes and cancels the previous account's follow-up", async () => {
    let finish!: () => void;
    mocks.record.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    mocks.id = "paid-reader";
    await render();
    await act(async () => {
      finish();
    });
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.catchUp).toHaveBeenCalledTimes(1);
  });
  it("retries a failed initial write without becoming an activity heartbeat", async () => {
    vi.useFakeTimers();
    mocks.record.mockRejectedValueOnce(new Error("Offline"));
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record.mock.calls[0]![0]).toEqual(
      mocks.record.mock.calls[1]![0],
    );
    expect(mocks.catchUp).toHaveBeenCalledTimes(1);
  });
});

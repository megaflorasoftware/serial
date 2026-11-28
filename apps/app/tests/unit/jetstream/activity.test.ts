// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppActivity } from "~/lib/hooks/useAppActivity";

const mocks = vi.hoisted(() => ({ id: "reader", activity: vi.fn() }));
vi.mock("~/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: mocks.id } } }),
}));
vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: { user: { recordActivity: mocks.activity } },
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
  return loading ? "Loading" : route;
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
  mocks.activity.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("authenticated layout activity", () => {
  it("does not repeat for checkout loading, renders or child-route navigation", async () => {
    await render(true);
    const initialCalls = mocks.activity.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);
    await render(false);
    await render(false, "/feeds");
    await render(false, "/views");
    expect(mocks.activity).toHaveBeenCalledTimes(initialCalls);
  });
  it("cancels the old account's request and starts one for the next account", async () => {
    await render();
    const previousSignal = mocks.activity.mock.calls.at(-1)![1]
      .signal as AbortSignal;
    const initialCalls = mocks.activity.mock.calls.length;
    mocks.id = "paid-reader";
    await render();
    expect(previousSignal.aborted).toBe(true);
    expect(mocks.activity).toHaveBeenCalledTimes(initialCalls + 1);
    const currentSignal = mocks.activity.mock.calls.at(-1)![1]
      .signal as AbortSignal;
    expect(currentSignal.aborted).toBe(false);
    mocks.id = "";
    await render();
    expect(currentSignal.aborted).toBe(true);
    expect(mocks.activity).toHaveBeenCalledTimes(initialCalls + 1);
  });
  it("keeps failed startup best effort without retries or a heartbeat", async () => {
    vi.useFakeTimers();
    mocks.activity.mockRejectedValue(new Error("Offline"));
    await render();
    const initialCalls = mocks.activity.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });
    expect(mocks.activity).toHaveBeenCalledTimes(initialCalls);
  });
});

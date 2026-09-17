// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefetchItemsButton } from "~/components/feed/RefetchItemsButton";

const state = vi.hoisted(() => ({
  refresh: vi.fn().mockResolvedValue(undefined),
  nextRefreshAt: null as number | null,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/" }),
}));
vi.mock("~/lib/data/store", () => ({ useFetchNewData: () => state.refresh }));
vi.mock("~/lib/data/reconciliation", () => ({
  useReconciliationDisplayStatus: () => "stale",
}));
vi.mock("~/lib/data/loading-machine", () => ({
  useLoadingMode: () => ({ mode: "idle" }),
  useIsLoadingActive: () => false,
  useNextRefreshAt: () => state.nextRefreshAt,
}));
vi.mock("~/components/feed/dialogStore", () => ({
  useDialogStore: () => false,
}));
vi.mock("~/lib/hooks/useShowShortcuts", () => ({
  useShowShortcuts: () => false,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount: () => void;
beforeEach(() => {
  state.refresh.mockClear();
  state.nextRefreshAt = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(RefetchItemsButton)));
  unmount = () => act(() => root.unmount());
  return container.querySelector("button")!;
}

describe("Refresh after rejected recovery", () => {
  it("shows stale data and permits click and keyboard recovery", async () => {
    const button = mount();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Refresh");
    await act(async () => {
      button.parentElement!.focus();
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Data may be stale. Refresh to try again.",
    );
    await act(async () => {
      button.click();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    });
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it("preserves the refresh cooldown for both click and keyboard recovery", async () => {
    state.nextRefreshAt = Date.now() + 60_000;
    const button = mount();
    expect(button.disabled).toBe(true);
    await act(async () => {
      button.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    });
    expect(state.refresh).not.toHaveBeenCalled();
    await act(async () => {
      button.parentElement!.focus();
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Data may be stale. Refresh to try again.",
    );
  });
  it("allows recovery when the existing cooldown expires", async () => {
    vi.useFakeTimers();
    state.nextRefreshAt = Date.now() + 1_000;
    const button = mount();
    expect(button.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(button.disabled).toBe(false);
    await act(async () => {
      button.click();
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});

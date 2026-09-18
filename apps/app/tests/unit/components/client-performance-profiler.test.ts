// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ClientPerformanceProfiler } from "~/components/debug/ClientPerformanceProfiler";

const readiness = vi.hoisted(() => ({
  waitForOfflineHydrationIdle: vi.fn(() => Promise.resolve()),
  flushNormalizedPersistence: vi.fn(() => Promise.resolve()),
}));
vi.mock("~/lib/data/offline-hydration", () => ({
  waitForOfflineHydrationIdle: readiness.waitForOfflineHydrationIdle,
}));
vi.mock("~/lib/data/normalized-idb-storage", () => ({
  flushNormalizedPersistence: readiness.flushNormalizedPersistence,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  window.history.replaceState({}, "", "/");
  vi.clearAllMocks();
});

it("exposes warm-reload readiness only for audited visits", async () => {
  let releaseHydration!: () => void;
  readiness.waitForOfflineHydrationIdle.mockReturnValueOnce(
    new Promise((resolve) => {
      releaseHydration = resolve;
    }),
  );
  let releasePersistence!: () => void;
  readiness.flushNormalizedPersistence.mockReturnValueOnce(
    new Promise((resolve) => {
      releasePersistence = resolve;
    }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ClientPerformanceProfiler, null, "app")));
  expect(
    (window as typeof window & { __SERIAL_CLIENT_PERFORMANCE__?: unknown })
      .__SERIAL_CLIENT_PERFORMANCE__,
  ).toBeUndefined();

  window.history.replaceState({}, "", "/?client-performance-audit=1");
  act(() => root.unmount());
  roots.pop();
  const auditedRoot = createRoot(container);
  roots.push(auditedRoot);
  act(() =>
    auditedRoot.render(createElement(ClientPerformanceProfiler, null, "app")),
  );
  const auditWindow = window as typeof window & {
    __SERIAL_CLIENT_PERFORMANCE__?: {
      readyForWarmReload: () => Promise<void>;
    };
  };
  let ready = false;
  const warmReload = auditWindow.__SERIAL_CLIENT_PERFORMANCE__
    ?.readyForWarmReload()
    .then(() => {
      ready = true;
    });
  expect(readiness.waitForOfflineHydrationIdle).toHaveBeenCalledOnce();
  expect(readiness.flushNormalizedPersistence).not.toHaveBeenCalled();
  expect(ready).toBe(false);

  releaseHydration();
  await Promise.resolve();
  expect(readiness.flushNormalizedPersistence).toHaveBeenCalledOnce();
  expect(ready).toBe(false);

  releasePersistence();
  await warmReload;
  expect(ready).toBe(true);
});

it("preserves application state when an audited visit navigates to the reader", () => {
  window.history.replaceState({}, "", "/?client-performance-audit=1");
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Application() {
    const [count, setCount] = useState(0);
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return createElement(
      "button",
      { onClick: () => setCount(count + 1) },
      count,
    );
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = () =>
    root.render(
      createElement(
        ClientPerformanceProfiler,
        null,
        createElement(Application),
      ),
    );
  act(render);
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toBe("1");

  window.history.pushState({}, "", "/read/article");
  act(render);

  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  expect(container.textContent).toBe("1");
});

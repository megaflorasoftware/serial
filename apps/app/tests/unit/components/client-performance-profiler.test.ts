// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ClientPerformanceProfiler } from "~/components/debug/ClientPerformanceProfiler";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  window.history.replaceState({}, "", "/");
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

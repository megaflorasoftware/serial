// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { useMediaQuery } from "~/lib/hooks/use-media-query";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("mounts the matching layout immediately and responds to query changes", () => {
  const listeners = new Set<() => void>();
  const media = {
    matches: true,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => media);
  const mobileMount = vi.fn();
  function Mobile() {
    useEffect(mobileMount, []);
    return "mobile";
  }
  function Layout() {
    return useMediaQuery("(min-width: 640px)")
      ? "desktop"
      : createElement(Mobile);
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(Layout)));
  expect(container.textContent).toBe("desktop");
  expect(mobileMount).not.toHaveBeenCalled();
  act(() => {
    media.matches = false;
    for (const listener of listeners) listener();
  });
  expect(container.textContent).toBe("mobile");
  expect(mobileMount).toHaveBeenCalledTimes(1);
});

it("hydrates the server fallback without a mismatch before applying the client query", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  function Layout() {
    return createElement(
      "div",
      null,
      useMediaQuery("(min-width: 640px)") ? "desktop" : "mobile",
    );
  }
  const container = document.createElement("div");
  container.innerHTML = renderToString(createElement(Layout));
  expect(container.textContent).toBe("mobile");
  const onRecoverableError = vi.fn();
  await act(async () => {
    roots.push(
      hydrateRoot(container, createElement(Layout), { onRecoverableError }),
    );
  });
  expect(container.textContent).toBe("desktop");
  expect(onRecoverableError).not.toHaveBeenCalled();
});

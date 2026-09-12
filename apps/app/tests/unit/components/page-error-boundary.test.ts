// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { getDefaultStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { PageErrorBoundary } from "~/components/PageErrorBoundary";
import { connectionStateAtom } from "~/lib/data/atoms";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function Thrower({ error }: { error: Error | null }) {
  if (error) throw error;
  return createElement("p", null, "Page content");
}

function renderBoundary(error: Error | null, resetKey = "/read/item-1") {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const render = (nextError: Error | null, nextResetKey = resetKey) =>
    act(() =>
      root.render(
        createElement(
          PageErrorBoundary,
          { resetKey: nextResetKey } as ComponentProps<
            typeof PageErrorBoundary
          >,
          createElement(Thrower, { error: nextError }),
        ),
      ),
    );
  render(error);
  return { container, render };
}

const chunkLoadError = new Error("Importing a module script failed.");

beforeEach(() => {
  // React re-reports caught render errors through console.error.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  getDefaultStore().set(connectionStateAtom, "unknown");
  vi.restoreAllMocks();
});

describe("PageErrorBoundary", () => {
  it("renders the page while nothing throws", () => {
    const { container } = renderBoundary(null);
    expect(container.textContent).toBe("Page content");
  });

  it("explains a failed chunk import as offline content while disconnected", () => {
    getDefaultStore().set(connectionStateAtom, "disconnected");
    const { container } = renderBoundary(chunkLoadError);

    expect(container.textContent).toBe("This content isn't available offline.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("asks for a connection check when a chunk import fails online", () => {
    getDefaultStore().set(connectionStateAtom, "connected");
    const { container } = renderBoundary(chunkLoadError);

    expect(container.textContent).toBe(
      "This content couldn't load. Check your connection and try again.",
    );
  });

  it("offers a reload for any other render failure", () => {
    const { container } = renderBoundary(new TypeError("boom"));

    expect(container.textContent).toContain("Something went wrong.");
    expect(container.querySelector("button")?.textContent).toBe("Reload");
  });

  it("clears the error once the location changes", () => {
    const { container, render } = renderBoundary(chunkLoadError);
    expect(container.textContent).not.toBe("Page content");

    render(null, "/");
    expect(container.textContent).toBe("Page content");
  });
});

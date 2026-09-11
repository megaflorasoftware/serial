// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtprotoConnectionStatus } from "~/components/connections/AtprotoConnectionRow";
import { AtprotoConnectionRow } from "~/components/connections/AtprotoConnectionRow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function renderRow(status: AtprotoConnectionStatus) {
  const onSelect = vi.fn();
  const onDisconnect = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(AtprotoConnectionRow, {
        isLoading: false,
        status,
        disconnecting: false,
        onSelect,
        onDisconnect,
      }),
    ),
  );
  const row = container.firstElementChild as HTMLElement;
  const buttons = Array.from(row.querySelectorAll("button"));
  return { row, buttons, onSelect, onDisconnect };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe("AtprotoConnectionRow", () => {
  it("makes the whole row the link affordance when nothing is connected", () => {
    const { row, buttons, onSelect } = renderRow({
      isConfigured: true,
      isConnected: false,
      needsReconnect: false,
      handle: null,
    });

    expect(row.getAttribute("role")).toBe("button");
    expect(buttons).toHaveLength(0);
    act(() => row.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("keeps the row inert and moves Reconnect into an amber banner", () => {
    const { row, buttons, onSelect, onDisconnect } = renderRow({
      isConfigured: true,
      isConnected: false,
      needsReconnect: true,
      handle: "alice.example",
    });

    expect(row.getAttribute("role")).toBeNull();
    expect(row.querySelector('[role="button"]')).toBeNull();
    expect(row.querySelector("span.text-muted-foreground")?.textContent).toBe(
      "alice.example",
    );
    const banner = row.querySelector(".bg-amber-500");
    expect(banner?.textContent).toContain("Sign-in expired");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Disconnect",
      "Reconnect",
    ]);
    expect(banner?.contains(buttons[1] ?? null)).toBe(true);
    act(() => buttons[1]?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    act(() => buttons[0]?.click());
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("shows only Disconnect once connected", () => {
    const { row, buttons, onSelect } = renderRow({
      isConfigured: true,
      isConnected: true,
      needsReconnect: false,
      handle: "alice.example",
    });

    expect(row.getAttribute("role")).toBeNull();
    expect(buttons.map((button) => button.textContent)).toEqual(["Disconnect"]);
    act(() => row.click());
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedAccountRow } from "~/components/connections/ConnectedAccountRow";
import { ConnectionListRow } from "~/components/connections/ConnectionListRow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  const row = container.firstElementChild as HTMLElement;
  return { row, buttons: Array.from(row.querySelectorAll("button")) };
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe("ConnectionListRow", () => {
  it("is a pure status row that navigates whenever the service is available", () => {
    const onSelect = vi.fn();
    const { row, buttons } = render(
      createElement(ConnectionListRow, {
        name: "Atmosphere",
        isLoading: false,
        isConfigured: true,
        statusText: "alice.example",
        onSelect,
      }),
    );

    expect(row.getAttribute("role")).toBe("button");
    expect(buttons).toHaveLength(0);
    expect(row.textContent).toContain("alice.example");
    act(() => row.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("stays inert while the status is still loading", () => {
    const onSelect = vi.fn();
    const { row } = render(
      createElement(ConnectionListRow, {
        name: "Atmosphere",
        isLoading: true,
        isConfigured: true,
        statusText: "alice.example",
        onSelect,
      }),
    );

    expect(row.getAttribute("role")).toBeNull();
    expect(row.textContent).toContain("Loading...");
    act(() => row.click());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("stays inert and reads Not available on an unconfigured instance", () => {
    const onSelect = vi.fn();
    const { row } = render(
      createElement(ConnectionListRow, {
        name: "Atmosphere",
        isLoading: false,
        isConfigured: false,
        statusText: "Not connected",
        onSelect,
      }),
    );

    expect(row.getAttribute("role")).toBeNull();
    expect(row.textContent).toContain("Not available");
    act(() => row.click());
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("ConnectedAccountRow", () => {
  it("shows only Disconnect while the connection is healthy", () => {
    const onDisconnect = vi.fn();
    const { buttons } = render(
      createElement(ConnectedAccountRow, {
        label: "alice.example",
        disconnecting: false,
        onDisconnect,
      }),
    );

    expect(buttons.map((button) => button.textContent)).toEqual(["Disconnect"]);
    act(() => buttons[0]?.click());
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("adds the amber reconnect banner when credentials were lost", () => {
    const onReconnect = vi.fn();
    const { row, buttons } = render(
      createElement(ConnectedAccountRow, {
        label: "alice.example",
        disconnecting: false,
        onDisconnect: vi.fn(),
        onReconnect,
      }),
    );

    const banner = row.querySelector(".bg-amber-500");
    expect(banner?.textContent).toContain("Sign-in expired");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Disconnect",
      "Reconnect",
    ]);
    expect(banner?.contains(buttons[1] ?? null)).toBe(true);
    act(() => buttons[1]?.click());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("holds both actions while a reconnect starts, spinning only Reconnect", () => {
    const { buttons } = render(
      createElement(ConnectedAccountRow, {
        label: "alice.example",
        disabled: true,
        disconnecting: false,
        onDisconnect: vi.fn(),
        onReconnect: vi.fn(),
        reconnecting: true,
      }),
    );

    expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
    expect(buttons[0]?.textContent).toBe("Disconnect");
    expect(buttons[0]?.querySelector(".animate-spin")).toBeNull();
    expect(buttons[1]?.querySelector(".animate-spin")).not.toBeNull();
  });
});

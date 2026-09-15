// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AtprotoConnectionListItem,
  AtprotoConnectionPane,
} from "~/components/connections/AtprotoConnection";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQueryClient: () => ({}),
}));
vi.mock("~/lib/orpc", () => ({
  orpc: {
    atproto: {
      getConnectionStatus: { queryOptions: () => ({}) },
      unlinkAccount: { mutationOptions: () => ({}) },
      reconnectAccount: { mutationOptions: () => ({}) },
    },
  },
}));
vi.mock("~/components/auth/AtprotoHandleField", () => ({
  AtprotoHandleField: () => null,
}));
vi.mock("~/components/connections/AtprotoSyncSettingsForm", () => ({
  AtprotoSyncSettingsForm: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];

function ConnectionNavigation() {
  const [showPane, setShowPane] = useState(false);
  return showPane
    ? createElement(AtprotoConnectionPane)
    : createElement(AtprotoConnectionListItem, {
        onSelect: () => setShowPane(true),
      });
}

function renderStatus(status: Partial<ReturnType<typeof useQuery>>) {
  vi.mocked(useQuery).mockReturnValue(status as ReturnType<typeof useQuery>);
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ConnectionNavigation)));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.clearAllMocks();
});

describe("Atmosphere connection status failures", () => {
  it("lets a failed initial status request reach the pane's Retry action", () => {
    const refetch = vi.fn();
    const container = renderStatus({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch,
    });

    expect(container.textContent).toContain("Couldn't load connection");
    expect(container.textContent).not.toContain("Not available");
    const row = container.querySelector<HTMLElement>('[role="button"]');
    expect(row).not.toBeNull();
    act(() => row?.click());

    expect(container.textContent).toContain(
      "Couldn't load your Atmosphere connection.",
    );
    const retry = container.querySelector("button");
    expect(retry?.textContent).toContain("Retry");
    act(() => retry?.click());
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("keeps a confirmed unconfigured instance unavailable", () => {
    const container = renderStatus({
      data: { isConfigured: false },
      isLoading: false,
      isError: false,
    });

    expect(container.textContent).toContain("Not available");
    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it("keeps the cached handle when a later status request fails", () => {
    const container = renderStatus({
      data: {
        isConfigured: true,
        isConnected: true,
        handle: "alice.example",
      },
      isLoading: false,
      isError: true,
    });

    expect(container.textContent).toContain("alice.example");
    expect(container.querySelector('[role="button"]')).not.toBeNull();
  });
});

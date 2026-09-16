// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AtprotoConnectionPane } from "~/components/connections/AtprotoConnection";

const { saveSettings, unlinkAccount, connectionStatus } = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  unlinkAccount: vi.fn(),
  connectionStatus: vi.fn(),
}));
vi.mock("~/lib/orpc", () => ({
  orpc: {
    atproto: {
      getSyncStatus: { queryKey: () => ["atproto-sync-status"] },
      getConnectionStatus: {
        queryOptions: () => ({
          queryKey: ["atproto-status"],
          queryFn: connectionStatus,
        }),
        queryKey: () => ["atproto-status"],
      },
      saveSyncSettings: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: saveSettings,
        }),
      },
      unlinkAccount: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: unlinkAccount,
        }),
      },
      reconnectAccount: { mutationOptions: () => ({}) },
    },
  },
}));
vi.mock("~/components/auth/AtprotoHandleField", () => ({
  AtprotoHandleField: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
const clients: QueryClient[] = [];

const connectedStatus = {
  isConnected: true,
  needsReconnect: false,
  isConfigured: true,
  handle: "alice.example",
  hasWriteScope: false,
  syncPreferences: { method: "none", importAsInactive: false },
};

beforeEach(() => {
  connectionStatus.mockResolvedValue(connectedStatus);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

async function renderPane() {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient();
  clients.push(client);
  await act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AtprotoConnectionPane),
      ),
    );
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector("form")).not.toBeNull(),
    );
  });
  const buttons = Array.from(container.querySelectorAll("button"));
  return {
    container,
    exportOption: buttons.find(
      (button) => button.textContent === "Export to Atmosphere",
    )!,
    disconnect: buttons.find((button) => button.textContent === "Disconnect")!,
    save: container.querySelector<HTMLButtonElement>('button[type="submit"]')!,
  };
}

function submit(container: HTMLElement) {
  container
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function pendingRequest() {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

it("restores all actions and keeps edits when Back returns from consent via bfcache", async () => {
  saveSettings.mockResolvedValue({ saved: false, consentUrl: "#consent" });
  const { container, exportOption, save, disconnect } = await renderPane();
  act(() => exportOption.click());
  expect(save.disabled).toBe(false);

  await act(async () => {
    submit(container);
    await vi.waitFor(() => expect(window.location.hash).toBe("#consent"));
  });
  expect(saveSettings).toHaveBeenCalledOnce();
  expect(save.disabled).toBe(true);
  expect(disconnect.disabled).toBe(true);

  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  expect(save.disabled).toBe(false);
  expect(disconnect.disabled).toBe(false);
  expect(exportOption.disabled).toBe(false);
  expect(exportOption.getAttribute("aria-checked")).toBe("true");
  expect(saveSettings).toHaveBeenCalledOnce();
});

it("locks Disconnect during Save and restores both actions if Save fails", async () => {
  const pending = pendingRequest();
  saveSettings.mockReturnValue(pending.promise);
  const { container, exportOption, save, disconnect } = await renderPane();
  act(() => exportOption.click());
  await act(async () => {
    submit(container);
    await vi.waitFor(() => expect(disconnect.disabled).toBe(true));
  });
  act(() => disconnect.click());
  expect(unlinkAccount).not.toHaveBeenCalled();
  await act(async () => {
    pending.reject(new Error("Save failed"));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
  });
  expect(disconnect.disabled).toBe(false);
  expect(exportOption.getAttribute("aria-checked")).toBe("true");
});

it("locks settings during Disconnect and keeps the draft if Disconnect fails", async () => {
  const pending = pendingRequest();
  unlinkAccount.mockReturnValue(pending.promise);
  const { exportOption, save, disconnect } = await renderPane();
  act(() => exportOption.click());
  await act(async () => {
    disconnect.click();
    await vi.waitFor(() => expect(save.disabled).toBe(true));
  });
  expect(exportOption.disabled).toBe(true);
  act(() => save.click());
  expect(saveSettings).not.toHaveBeenCalled();
  await act(async () => {
    pending.reject(new Error("Disconnect failed"));
    await vi.waitFor(() => expect(save.disabled).toBe(false));
  });
  expect(disconnect.disabled).toBe(false);
  expect(exportOption.getAttribute("aria-checked")).toBe("true");
});

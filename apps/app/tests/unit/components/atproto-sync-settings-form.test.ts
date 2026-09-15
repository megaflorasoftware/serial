// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AtprotoSyncSettingsForm } from "~/components/connections/AtprotoSyncSettingsForm";

const saveSettings = vi.hoisted(() => vi.fn());
vi.mock("~/lib/orpc", () => ({
  orpc: {
    atproto: {
      saveSyncSettings: {
        mutationOptions: (options: Record<string, unknown>) => ({
          ...options,
          mutationFn: saveSettings,
        }),
      },
    },
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
const clients: QueryClient[] = [];

beforeEach(() => {
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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("restores editable preferences when Back returns from consent via bfcache", async () => {
  saveSettings.mockResolvedValue({ saved: false, consentUrl: "#consent" });
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient();
  clients.push(client);

  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AtprotoSyncSettingsForm, {
          savedPreferences: { method: "none", importAsInactive: false },
          hasWriteScope: false,
          disabled: false,
        }),
      ),
    ),
  );
  const exportOption = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Export to Atmosphere",
  );
  expect(exportOption).toBeDefined();
  act(() => exportOption?.click());
  const save = container.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  expect(save?.disabled).toBe(false);

  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#consent"));
  });
  expect(saveSettings).toHaveBeenCalledOnce();
  expect(save?.disabled).toBe(true);

  act(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  expect(save?.disabled).toBe(false);
  expect(exportOption?.disabled).toBe(false);
  expect(exportOption?.getAttribute("aria-checked")).toBe("true");
  expect(saveSettings).toHaveBeenCalledOnce();
});

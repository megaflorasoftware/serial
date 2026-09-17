// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { OnboardingSyncSlide } from "~/components/onboarding/OnboardingSyncSlide";

const { connectionStatus, advanceOnboarding, advanceSavedOnboardingStep } =
  vi.hoisted(() => ({
    connectionStatus: vi.fn(),
    advanceOnboarding: vi.fn(),
    advanceSavedOnboardingStep: vi.fn(),
  }));

vi.mock("~/lib/orpc", () => ({
  orpc: {
    atproto: {
      getConnectionStatus: {
        queryOptions: () => ({
          queryKey: ["atproto-status"],
          queryFn: connectionStatus,
        }),
      },
    },
  },
}));
vi.mock("~/lib/onboarding/store", () => ({
  advanceOnboarding,
  advanceSavedOnboardingStep,
}));
vi.mock("~/components/connections/AtprotoConnection", () => ({
  useAtprotoReconnect: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("~/components/connections/ConnectedAccountRow", () => ({
  ReconnectBanner: () => createElement("div", null, "Reconnect"),
}));
vi.mock("~/components/connections/AtprotoSyncSettingsForm", () => ({
  useAtprotoSyncSettingsSave: () => ({ busy: false, save: vi.fn() }),
  AtprotoSyncSettingsForm: ({
    savedPreferences,
  }: {
    savedPreferences: { method: string };
  }) =>
    createElement(
      "div",
      { "data-testid": "sync-form" },
      savedPreferences.method,
    ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
const clients: QueryClient[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const disconnected = {
  isConnected: false,
  needsReconnect: false,
  hasWriteScope: false,
  syncPreferences: { method: "none", importAsInactive: false },
};
const connected = {
  ...disconnected,
  isConnected: true,
  syncPreferences: { method: "import", importAsInactive: true },
};

it("waits for the live account status before deciding sync eligibility", async () => {
  const fresh = deferred<typeof connected>();
  connectionStatus.mockReturnValue(fresh.promise);
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  clients.push(client);
  client.setQueryData(["atproto-status", "account-one"], disconnected);
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);

  await act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(OnboardingSyncSlide, { run: 4, userId: "account-one" }),
      ),
    );
  });

  expect(container.textContent).toContain("Loading your connection");
  expect(container.querySelector('[data-testid="sync-form"]')).toBeNull();
  expect(advanceOnboarding).not.toHaveBeenCalled();

  await act(async () => {
    fresh.resolve(connected);
    await vi.waitFor(() =>
      expect(
        container.querySelector('[data-testid="sync-form"]'),
      ).not.toBeNull(),
    );
  });

  expect(container.textContent).toContain("import");
  expect(advanceOnboarding).not.toHaveBeenCalled();
});

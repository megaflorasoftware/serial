// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionStateAtom } from "~/lib/data/atoms";
import { markDataSubscriptionPaused } from "~/lib/data/subscriptionConnection";
import { useDataSubscription } from "~/lib/data/useDataSubscription";

/**
 * The live stream lifecycle as the app sees it through the connection
 * atom. A cleanly ended stream (proxy idle timeout, deploy rollover) must
 * not flip the app to `disconnected` before the retry; only a reconnect
 * that fails does.
 */

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));

vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: { initial: { subscribe: mocks.subscribe } },
}));
vi.mock("~/lib/data/reconciliation", () => ({
  dataReconciliation: {
    receivePublishedChunks: vi.fn(),
    sseConnectionChanged: vi.fn(),
    subscriptionAttemptFailed: vi.fn(),
    environmentChanged: vi.fn(),
  },
}));
vi.mock("~/lib/data/loading-machine", () => ({
  loadingActor: { send: vi.fn() },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const RETRY_DELAY_MS = 1000;

function Subscriber() {
  useDataSubscription();
  return null;
}

/** A stream that yields one chunk and then ends without an error. */
async function* cleanlyEndedStream() {
  yield await Promise.resolve({ type: "noop" });
}

function mount() {
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Subscriber)));
  return () => act(() => root.unmount());
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useDataSubscription", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The module-level connected flag outlives each mount.
    markDataSubscriptionPaused();
    getDefaultStore().set(connectionStateAtom, "unknown");
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("stays connected through the retry after a cleanly ended stream", async () => {
    mocks.subscribe.mockImplementation(() =>
      Promise.resolve(cleanlyEndedStream()),
    );
    unmount = mount();
    await settle();
    expect(getDefaultStore().get(connectionStateAtom)).toBe("connected");
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    // The stream has ended and the loop is sleeping before its redial.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    });
    expect(getDefaultStore().get(connectionStateAtom)).toBe("connected");
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(getDefaultStore().get(connectionStateAtom)).toBe("connected");
  });

  it("establishes disconnected only once the reconnect after a clean end fails", async () => {
    mocks.subscribe
      .mockImplementationOnce(() => Promise.resolve(cleanlyEndedStream()))
      .mockImplementationOnce(() => Promise.reject(new Error("unreachable")))
      .mockImplementation(() => new Promise(() => {}));
    unmount = mount();
    await settle();
    expect(getDefaultStore().get(connectionStateAtom)).toBe("connected");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    });
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(getDefaultStore().get(connectionStateAtom)).toBe("disconnected");
  });
});

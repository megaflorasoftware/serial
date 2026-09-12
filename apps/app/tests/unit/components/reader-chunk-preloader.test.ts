// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { getDefaultStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderChunkPreloader } from "~/components/pwa/ReaderChunkPreloader";
import { connectionStateAtom } from "~/lib/data/atoms";
import { bookmarkCapturesStore } from "~/lib/data/bookmarks/capture-store";
import { feedItemsStore } from "~/lib/data/store";

const mocks = vi.hoisted(() => ({
  loadRouteChunk: vi.fn(() => Promise.resolve()),
  readerRoute: { id: "/_app/read/$id" },
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    routesById: { "/_app/read/$id": mocks.readerRoute },
    loadRouteChunk: mocks.loadRouteChunk,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(ReaderChunkPreloader)));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  getDefaultStore().set(connectionStateAtom, "unknown");
  feedItemsStore.setState({ retainedFeedItemBodyIds: {} });
  bookmarkCapturesStore.getState().reset();
  vi.clearAllMocks();
});

describe("ReaderChunkPreloader", () => {
  it("fetches the reader chunk once retained content meets a live connection", () => {
    render();
    expect(mocks.loadRouteChunk).not.toHaveBeenCalled();

    // Content without a connection: a failed import would poison the route.
    act(() =>
      feedItemsStore.setState({ retainedFeedItemBodyIds: { "item-1": true } }),
    );
    act(() => getDefaultStore().set(connectionStateAtom, "disconnected"));
    expect(mocks.loadRouteChunk).not.toHaveBeenCalled();

    act(() => getDefaultStore().set(connectionStateAtom, "connected"));
    expect(mocks.loadRouteChunk).toHaveBeenCalledTimes(1);
    expect(mocks.loadRouteChunk).toHaveBeenCalledWith(mocks.readerRoute);

    // One attempt per session, regardless of later state churn.
    act(() => getDefaultStore().set(connectionStateAtom, "disconnected"));
    act(() => getDefaultStore().set(connectionStateAtom, "connected"));
    expect(mocks.loadRouteChunk).toHaveBeenCalledTimes(1);
  });
});

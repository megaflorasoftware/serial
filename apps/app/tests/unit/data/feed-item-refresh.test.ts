// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationFeedItem } from "~/server/db/schema";
import { useRefreshFeedItem } from "~/lib/hooks/useRefreshFeedItem";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  setFeedItem: vi.fn(),
  retain: vi.fn(),
  items: {},
}));
vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: { feedItem: { getById: mocks.getById } },
}));
vi.mock("~/lib/data/store", () => ({
  feedItemsStore: {
    getState: () => ({
      feedItemsDict: mocks.items,
      setFeedItem: mocks.setFeedItem,
    }),
  },
  retainLoadedFeedItemBody: mocks.retain,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.items = {};
});

function ReaderLoad({ id }: { id: string }) {
  const state = useRefreshFeedItem(id);
  return createElement("output", null, JSON.stringify(state));
}

describe("Feed item body refresh", () => {
  it.each(["rejected", "missing", "stale", "empty-body"])(
    "distinguishes successful loading from completion for %s responses",
    async (result) => {
      const item = {
        id: "article",
        content: "",
        updatedAt: new Date(0),
      } as ApplicationFeedItem;
      if (result === "stale")
        mocks.items.article = { ...item, updatedAt: new Date(1) };
      let resolve!: (item: ApplicationFeedItem | undefined) => void;
      let reject!: (error: Error) => void;
      mocks.getById.mockReturnValue(
        new Promise<ApplicationFeedItem | undefined>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(() => {
          root.render(createElement(ReaderLoad, { id: "article" }));
        });
        expect(JSON.parse(container.textContent)).toEqual({
          complete: false,
          succeeded: false,
        });
        await act(() => {
          if (result === "rejected") reject(new Error("Disconnected"));
          else resolve(result === "missing" ? undefined : item);
        });
        expect(JSON.parse(container.textContent)).toEqual({
          complete: true,
          succeeded: result === "empty-body",
        });
        expect(mocks.setFeedItem).toHaveBeenCalledTimes(
          result === "empty-body" ? 1 : 0,
        );
        mocks.getById.mockReturnValue(new Promise(() => undefined));
        await act(() => {
          root.render(createElement(ReaderLoad, { id: "next" }));
        });
        expect(JSON.parse(container.textContent)).toEqual({
          complete: false,
          succeeded: false,
        });
      } finally {
        await act(() => {
          root.unmount();
        });
      }
    },
  );
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationFeedItem } from "~/server/db/schema";
import { useRefreshFeedItem } from "~/lib/hooks/useRefreshFeedItem";

const mocks = vi.hoisted(() => {
  const items: Record<string, ApplicationFeedItem> = {};
  return { getById: vi.fn(), setFeedItem: vi.fn(), retain: vi.fn(), items };
});
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
  vi.resetAllMocks();
  mocks.items = {};
});

function htmlBody(html: string, revision = "body-revision") {
  return { form: "html", html, revision } as const;
}

function ReaderLoad({ id }: { id: string }) {
  const state = useRefreshFeedItem(id);
  return createElement("output", null, JSON.stringify(state));
}

describe("Feed item body refresh", () => {
  it("does not reuse an earlier visit's success while returning to an item", async () => {
    const item = {
      id: "article",
      body: null,
      updatedAt: new Date(0),
    } as unknown as ApplicationFeedItem;
    let finishOther!: (item: ApplicationFeedItem) => void;
    let finishReturn!: (item: ApplicationFeedItem) => void;
    mocks.getById
      .mockReturnValueOnce(Promise.resolve(item))
      .mockReturnValueOnce(
        new Promise<ApplicationFeedItem>((resolve) => {
          finishOther = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ApplicationFeedItem>((resolve) => {
          finishReturn = resolve;
        }),
      );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(createElement(ReaderLoad, { id: "article" }));
      });
      expect(JSON.parse(container.textContent)).toMatchObject({
        succeeded: true,
      });
      await act(() => {
        root.render(createElement(ReaderLoad, { id: "other" }));
      });
      expect(JSON.parse(container.textContent)).toMatchObject({
        succeeded: false,
      });
      await act(() => {
        root.render(createElement(ReaderLoad, { id: "article" }));
      });
      expect(JSON.parse(container.textContent)).toEqual({
        complete: false,
        succeeded: false,
      });
      await act(() => {
        finishOther({ ...item, id: "other" });
      });
      expect(JSON.parse(container.textContent)).toEqual({
        complete: false,
        succeeded: false,
      });
      await act(() => {
        finishReturn(item);
      });
      expect(JSON.parse(container.textContent)).toEqual({
        complete: true,
        succeeded: true,
      });
    } finally {
      await act(() => {
        root.unmount();
      });
    }
  });

  it("hydrates the same body revision without overwriting a newer save/archive choice", async () => {
    const response = {
      id: "article",
      body: htmlBody("<p>Loaded body</p>"),
      contentHash: "same-body",
      updatedAt: new Date(0),
      isWatched: false,
      isWatchLater: false,
      progress: 0,
    } as unknown as ApplicationFeedItem;
    let resolve!: (item: ApplicationFeedItem) => void;
    mocks.getById.mockReturnValue(
      new Promise<ApplicationFeedItem>((done) => {
        resolve = done;
      }),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(createElement(ReaderLoad, { id: "article" }));
      });
      mocks.items.article = {
        ...response,
        body: null,
        updatedAt: new Date(1),
        isWatched: true,
        isWatchLater: true,
        progress: 12,
      };
      await act(() => {
        resolve(response);
      });
      expect(mocks.setFeedItem).toHaveBeenCalledWith(
        "article",
        expect.objectContaining({
          body: response.body,
          updatedAt: new Date(1),
          isWatched: true,
          isWatchLater: true,
          progress: 12,
        }),
      );
      expect(JSON.parse(container.textContent)).toEqual({
        complete: true,
        succeeded: true,
      });
    } finally {
      await act(() => {
        root.unmount();
      });
    }
  });

  it.each([
    "removed",
    "changed-metadata",
    "changed-metadata-new-body",
    "changed-progress-newer-body",
    "unchanged-metadata",
  ])("respects concurrent item state for %s", async (scenario) => {
    const response = {
      id: "article",
      body: htmlBody("Loaded body"),
      contentHash: "same-body",
      updatedAt: new Date(1),
      isWatched: false,
      isWatchLater: false,
      progress: 0,
      duration: 0,
    } as unknown as ApplicationFeedItem;
    mocks.items.article = { ...response, body: null };
    let finish!: (item: ApplicationFeedItem) => void;
    mocks.getById.mockReturnValueOnce(
      new Promise<ApplicationFeedItem>((resolve) => {
        finish = resolve;
      }),
    );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(createElement(ReaderLoad, { id: "article" }));
      });
      if (scenario === "changed-progress-newer-body")
        mocks.items.article = {
          ...response,
          body: null,
          progress: 12,
          duration: 40,
        };
      if (scenario === "removed") delete mocks.items.article;
      else if (scenario.startsWith("changed-metadata"))
        mocks.items.article = {
          ...response,
          body: null,
          isWatched: true,
          isWatchLater: true,
          progress: 12,
          duration: 40,
        };
      await act(() => {
        finish(
          scenario === "unchanged-metadata"
            ? {
                ...response,
                isWatched: true,
                isWatchLater: true,
                progress: 12,
                duration: 40,
              }
            : scenario === "changed-progress-newer-body"
              ? {
                  ...response,
                  contentHash: "new-body",
                  updatedAt: new Date(2),
                  isWatched: true,
                  isWatchLater: true,
                }
              : scenario === "changed-metadata-new-body"
                ? { ...response, contentHash: "new-body" }
                : response,
        );
      });
      expect(mocks.getById).toHaveBeenCalledTimes(1);
      if (scenario === "removed") {
        expect(mocks.setFeedItem).not.toHaveBeenCalled();
        expect(mocks.retain).not.toHaveBeenCalled();
      } else {
        expect(mocks.setFeedItem).toHaveBeenCalledWith(
          "article",
          expect.objectContaining({
            body: htmlBody("Loaded body"),
            contentHash:
              scenario === "changed-metadata-new-body" ||
              scenario === "changed-progress-newer-body"
                ? "new-body"
                : "same-body",
            isWatched: true,
            isWatchLater: true,
            progress: 12,
            duration: 40,
          }),
        );
      }
      expect(JSON.parse(container.textContent)).toEqual({
        complete: true,
        succeeded: scenario !== "removed",
      });
    } finally {
      await act(() => {
        root.unmount();
      });
    }
  });

  it("retries once when a newer document loses its body during loading", async () => {
    const oldItem = {
      id: "article",
      body: htmlBody("Old body"),
      contentHash: "old",
      updatedAt: new Date(0),
      progress: 0,
      duration: 0,
    } as unknown as ApplicationFeedItem;
    const currentItem = {
      ...oldItem,
      body: null,
      contentHash: "new",
      updatedAt: new Date(1),
    };
    mocks.items.article = oldItem;
    let finishOld!: (item: ApplicationFeedItem) => void;
    let finishRetry!: (item: ApplicationFeedItem) => void;
    mocks.getById
      .mockReturnValueOnce(
        new Promise<ApplicationFeedItem>((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<ApplicationFeedItem>((resolve) => {
          finishRetry = resolve;
        }),
      );
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() => {
        root.render(createElement(ReaderLoad, { id: "article" }));
      });
      mocks.items.article = { ...currentItem, progress: 12, duration: 40 };
      await act(() => {
        finishOld(oldItem);
      });
      expect(mocks.getById).toHaveBeenCalledTimes(2);
      expect(mocks.setFeedItem).not.toHaveBeenCalled();
      expect(JSON.parse(container.textContent)).toEqual({
        complete: false,
        succeeded: false,
      });
      await act(() => {
        finishRetry(currentItem);
      });
      expect(mocks.setFeedItem).toHaveBeenCalledWith(
        "article",
        expect.objectContaining({
          body: null,
          contentHash: "new",
          progress: 12,
          duration: 40,
        }),
      );
      expect(JSON.parse(container.textContent)).toEqual({
        complete: true,
        succeeded: true,
      });
    } finally {
      await act(() => {
        root.unmount();
      });
    }
  });

  it.each([false, true])(
    "handles tied revision timestamps with concurrent update=%s",
    async (concurrent) => {
      const oldItem = {
        id: "article",
        body: htmlBody("Old body"),
        contentHash: "old",
        updatedAt: new Date(1),
      } as unknown as ApplicationFeedItem;
      const newItem = { ...oldItem, body: null, contentHash: "new" };
      mocks.items.article = oldItem;
      let finish!: (item: ApplicationFeedItem) => void;
      mocks.getById
        .mockReturnValueOnce(
          new Promise<ApplicationFeedItem>((resolve) => {
            finish = resolve;
          }),
        )
        .mockResolvedValueOnce(newItem);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        await act(() => {
          root.render(createElement(ReaderLoad, { id: "article" }));
        });
        if (concurrent) mocks.items.article = newItem;
        await act(() => {
          finish(concurrent ? oldItem : newItem);
        });
        expect(mocks.getById).toHaveBeenCalledTimes(concurrent ? 2 : 1);
        expect(mocks.setFeedItem).toHaveBeenCalledTimes(1);
        expect(mocks.setFeedItem).toHaveBeenCalledWith(
          "article",
          expect.objectContaining({ contentHash: "new", body: null }),
        );
        expect(JSON.parse(container.textContent)).toEqual({
          complete: true,
          succeeded: true,
        });
      } finally {
        await act(() => {
          root.unmount();
        });
      }
    },
  );

  it.each(["rejected", "missing", "stale", "empty-body"])(
    "distinguishes successful loading from completion for %s responses",
    async (result) => {
      const item = {
        id: "article",
        body: null,
        updatedAt: new Date(0),
        contentHash: "old-body",
      } as unknown as ApplicationFeedItem;
      if (result === "stale")
        mocks.items.article = {
          ...item,
          updatedAt: new Date(1),
          contentHash: "new-body",
        };
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
        expect(mocks.getById).toHaveBeenCalledTimes(result === "stale" ? 2 : 1);
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

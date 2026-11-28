// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAuthSession } from "../../lib/auth";
import type {
  BookmarkMessageResponse,
  BookmarkWorkspace,
} from "../../lib/bookmarks";
import { useBookmarkWorkspace } from "./useBookmarkWorkspace";

const session: ExtensionAuthSession = {
  version: 2,
  instance: "https://serial.example",
  token: "serial_ext_test",
  expiresAt: Date.now() + 60_000,
  user: { id: "user-one", name: "User" },
};

const workspace: BookmarkWorkspace = {
  bookmark: {
    id: "bookmark-one",
    sourceUrl: "https://example.com/article",
    platform: "website",
    contentType: "text",
    title: "Article",
    author: null,
    siteName: "Example",
    thumbnailUrl: null,
    iconUrl: null,
    captureHash: null,
    viewIds: [],
    tagIds: [],
  },
  views: [],
  tags: [],
  feeds: [],
  disposition: "created",
  capture: { status: "captured" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("extension Bookmark workspace lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: ReturnType<typeof useBookmarkWorkspace>;
  const onAuthExpired = vi.fn();

  function Harness() {
    controller = useBookmarkWorkspace({ session, onAuthExpired });
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onAuthExpired.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("makes the editor ready before delayed Feed discovery completes", async () => {
    const capture = deferred<BookmarkMessageResponse>();
    const discovery = deferred<BookmarkMessageResponse>();
    const sendMessage = vi.fn((message: { type: string }) =>
      message.type === "bookmark.capture-active"
        ? capture.promise
        : discovery.promise,
    );
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    await act(async () => root.render(createElement(Harness)));
    expect(controller.status).toBe("loading");

    await act(async () => {
      capture.resolve({ ok: true, status: "saved", workspace });
      await capture.promise;
    });

    expect(controller.status).toBe("saved");
    expect(controller.workspace?.bookmark.id).toBe("bookmark-one");
    expect(controller.feedDiscoveryStatus).toBe("loading");
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "bookmark.discover-feeds",
      sourceUrl: "https://example.com/article",
    });

    await act(async () => {
      discovery.resolve({
        ok: true,
        status: "feeds-discovered",
        feeds: [{ url: "https://example.com/feed.xml", title: "Example Feed" }],
      });
      await discovery.promise;
    });

    expect(controller.status).toBe("saved");
    expect(controller.feedDiscoveryStatus).toBe("loaded");
    expect(controller.workspace?.feeds).toEqual([
      { url: "https://example.com/feed.xml", title: "Example Feed" },
    ]);
  });

  it("discovers Atmosphere origins even when capture already found RSS", async () => {
    const declaredWorkspace = {
      ...workspace,
      feeds: [{ url: "https://example.com/declared.xml" }],
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: "saved",
        workspace: declaredWorkspace,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "feeds-discovered",
        feeds: declaredWorkspace.feeds,
      });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    await act(async () => root.render(createElement(Harness)));

    expect(controller.status).toBe("saved");
    expect(controller.feedDiscoveryStatus).toBe("loaded");
    expect(controller.workspace?.feeds).toEqual(declaredWorkspace.feeds);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("preserves captured Feeds missing from a partial remote result", async () => {
    const capturedFeeds = [
      { url: "https://example.com/main.xml", title: "Captured main" },
      { url: "https://example.com/private.xml", title: "Captured private" },
    ];
    const combinedFeed = {
      url: "https://example.com/main.atom",
      title: "Remote publication",
      origins: [
        {
          kind: "rss" as const,
          locator: "https://example.com/main.atom",
          alternateUrls: ["https://example.com/main.xml"],
        },
        {
          kind: "atproto" as const,
          locator: "at://did:plc:example/site.standard.publication/main",
        },
      ],
    };
    const atmosphereFeed = {
      url: "https://atmosphere.example",
      title: "Atmosphere only",
      origins: [
        {
          kind: "atproto" as const,
          locator: "at://did:plc:atmosphere/site.standard.publication/main",
        },
      ],
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: "saved",
        workspace: { ...workspace, feeds: capturedFeeds },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "feeds-discovered",
        feeds: [combinedFeed, atmosphereFeed],
      });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    await act(async () => root.render(createElement(Harness)));

    expect(controller.workspace?.feeds).toEqual([
      combinedFeed,
      capturedFeeds[1],
      atmosphereFeed,
    ]);
  });

  it("does not let Atmosphere results exhaust the captured Feed limit", async () => {
    const capturedFeed = {
      url: "https://example.com/private.xml",
      title: "Captured private",
    };
    const atmosphereFeeds = Array.from({ length: 16 }, (_, index) => ({
      url: `https://publication-${index}.example`,
      title: `Publication ${index}`,
      origins: [
        {
          kind: "atproto" as const,
          locator: `at://did:plc:${index}/site.standard.publication/main`,
        },
      ],
    }));
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: "saved",
        workspace: { ...workspace, feeds: [capturedFeed] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "feeds-discovered",
        feeds: atmosphereFeeds,
      });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    await act(async () => root.render(createElement(Harness)));

    expect(controller.workspace?.feeds).toHaveLength(16);
    expect(controller.workspace?.feeds[0]).toEqual(capturedFeed);
    expect(controller.workspace?.feeds.slice(1)).toEqual(
      atmosphereFeeds.slice(0, 15),
    );
  });

  it("keeps captured Feeds when remote discovery returns none", async () => {
    const capturedFeeds = [
      { url: "https://example.com/private.xml", title: "Captured private" },
    ];
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: "saved",
        workspace: { ...workspace, feeds: capturedFeeds },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "feeds-discovered",
        feeds: [],
      });
    vi.stubGlobal("browser", { runtime: { sendMessage } });

    await act(async () => root.render(createElement(Harness)));

    expect(controller.workspace?.feeds).toEqual(capturedFeeds);
  });

  it.each([
    {
      name: "empty result",
      settle: (request: ReturnType<typeof deferred<BookmarkMessageResponse>>) =>
        request.resolve({ ok: true, status: "feeds-discovered", feeds: [] }),
      expectedStatus: "loaded" as const,
    },
    {
      name: "failure response",
      settle: (request: ReturnType<typeof deferred<BookmarkMessageResponse>>) =>
        request.resolve({
          ok: false,
          authExpired: false,
          error: "Unable to discover Feeds",
        }),
      expectedStatus: "error" as const,
    },
    {
      name: "timeout rejection",
      settle: (request: ReturnType<typeof deferred<BookmarkMessageResponse>>) =>
        request.reject(new Error("request timed out")),
      expectedStatus: "error" as const,
    },
  ])(
    "keeps Bookmark success through $name",
    async ({ settle, expectedStatus }) => {
      const discovery = deferred<BookmarkMessageResponse>();
      const sendMessage = vi.fn((message: { type: string }) =>
        message.type === "bookmark.capture-active"
          ? Promise.resolve({
              ok: true,
              status: "saved",
              workspace,
            } satisfies BookmarkMessageResponse)
          : discovery.promise,
      );
      vi.stubGlobal("browser", { runtime: { sendMessage } });

      await act(async () => root.render(createElement(Harness)));
      expect(controller.status).toBe("saved");
      expect(controller.feedDiscoveryStatus).toBe("loading");

      await act(async () => {
        settle(discovery);
        await discovery.promise.catch(() => undefined);
      });

      expect(controller.status).toBe("saved");
      expect(controller.feedDiscoveryStatus).toBe(expectedStatus);
      expect(controller.workspace?.bookmark.id).toBe("bookmark-one");
    },
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { ApplicationFeedItem } from "~/server/db/schema";
import type { ApplicationBookmark } from "~/server/mixed-content/projection";
import { bookmarkCapturesStore } from "~/lib/data/bookmarks/capture-store";
import { bookmarksStore } from "~/lib/data/bookmarks/store";
import {
  hydrateOfflineBodiesForPage,
  invalidateOfflineHydration,
  planPageBodyHydration,
  waitForOfflineHydrationIdle,
} from "~/lib/data/offline-hydration";
import { feedItemsStore } from "~/lib/data/store";

const mocks = vi.hoisted(() => ({
  requestFullTextForItems: vi.fn(),
  getCaptures: vi.fn(),
}));

vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: {
    bookmark: { getCaptures: mocks.getCaptures },
    initial: { requestFullTextForItems: mocks.requestFullTextForItems },
  },
}));

const now = new Date("2026-08-31T12:00:00.000Z");

function htmlBody(html: string, revision = "content-hash") {
  return { form: "html", html, revision } as const;
}

function feedItem(
  overrides: Partial<ApplicationFeedItem> = {},
): ApplicationFeedItem {
  return {
    sourceKind: "rss",
    atprotoUri: null,
    sourceCid: null,
    bodySource: "rss",
    tags: [],
    id: "feed-item-one",
    feedId: 1,
    contentId: "content-one",
    title: "Article",
    author: "Author",
    url: "https://example.com/article",
    thumbnail: "",
    body: null,
    contentSnippet: "preview",
    contentType: "text",
    isWatched: false,
    isWatchLater: true,
    progress: 0,
    duration: 0,
    orientation: null,
    postedAt: now,
    createdAt: now,
    updatedAt: now,
    isWatchedUpdatedAt: null,
    isWatchLaterUpdatedAt: null,
    contentHash: "content-hash",
    platform: "website",
    ...overrides,
  };
}

function bookmark(
  overrides: Partial<ApplicationBookmark> = {},
): ApplicationBookmark {
  return {
    id: "bookmark-one",
    userId: "user-one",
    sourceUrl: "https://example.com/bookmark",
    effectiveUrl: "https://example.com/bookmark",
    canonicalUrl: "https://example.com/bookmark",
    platform: "website",
    contentType: "text",
    orientation: null,
    contentId: null,
    classificationSource: "url",
    classifierVersion: 1,
    isSaved: true,
    isRead: false,
    progress: 0,
    duration: 0,
    savedUpdatedAt: now,
    readUpdatedAt: now,
    progressUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
    title: "Bookmark",
    description: null,
    author: null,
    siteName: "example.com",
    publishedAt: null,
    iconUrl: null,
    thumbnailUrl: null,
    previewSource: "url",
    captureHash: "capture-hash",
    capturedAt: now,
    viewIds: [],
    tagIds: [],
    ...overrides,
  } as unknown as ApplicationBookmark;
}

function planWith(input: {
  feedItems?: ApplicationFeedItem[];
  bookmarks?: ApplicationBookmark[];
  retainedFeedIds?: string[];
  capturedBookmarkIds?: string[];
}) {
  return planPageBodyHydration({
    feedItems: input.feedItems ?? [],
    bookmarks: input.bookmarks ?? [],
    hasRetainedFeedBody: (id) => input.retainedFeedIds?.includes(id) === true,
    hasBookmarkCapture: (id) =>
      input.capturedBookmarkIds?.includes(id) === true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateOfflineHydration();
  feedItemsStore.getState().reset();
  bookmarksStore.getState().reset();
  bookmarkCapturesStore.getState().reset();
});

describe("planPageBodyHydration", () => {
  it.each([
    ["video item", feedItem({ contentType: "video" })],
    ["archived item", feedItem({ isWatched: true })],
    ["inbox item", feedItem({ isWatchLater: false })],
  ])("skips a %s entirely", (_label, item) => {
    expect(planWith({ feedItems: [item] })).toEqual({
      retainLoadedFeedItemIds: [],
      fetchFeedItemIds: [],
      fetchBookmarkIds: [],
    });
  });

  it("fetches a Saved Unread text item without a body", () => {
    expect(planWith({ feedItems: [feedItem()] }).fetchFeedItemIds).toEqual([
      "feed-item-one",
    ]);
  });

  it("retains a loaded body only while it is unmarked", () => {
    const loaded = feedItem({ body: htmlBody("<p>Body</p>") });
    expect(planWith({ feedItems: [loaded] }).retainLoadedFeedItemIds).toEqual([
      "feed-item-one",
    ]);
    expect(
      planWith({ feedItems: [loaded], retainedFeedIds: ["feed-item-one"] }),
    ).toEqual({
      retainLoadedFeedItemIds: [],
      fetchFeedItemIds: [],
      fetchBookmarkIds: [],
    });
  });

  it.each([
    ["uncaptured", bookmark({ captureHash: null })],
    ["unsaved", bookmark({ isSaved: false })],
    ["archived", bookmark({ isRead: true })],
    ["video", bookmark({ contentType: "video" })],
  ])("skips an %s Bookmark", (_label, entity) => {
    expect(planWith({ bookmarks: [entity] }).fetchBookmarkIds).toEqual([]);
  });

  it("fetches a Saved Unread capture only while it is absent", () => {
    expect(planWith({ bookmarks: [bookmark()] }).fetchBookmarkIds).toEqual([
      "bookmark-one",
    ]);
    expect(
      planWith({
        bookmarks: [bookmark()],
        capturedBookmarkIds: ["bookmark-one"],
      }).fetchBookmarkIds,
    ).toEqual([]);
  });
});

describe("hydrateOfflineBodiesForPage", () => {
  it("batches streamed captures for a fixed 100 ms without delaying Feed bodies", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = bookmark({ id: "stream-a" });
    const second = bookmark({ id: "stream-b" });
    const third = bookmark({ id: "stream-c" });
    const item = feedItem();
    bookmarksStore.getState().upsertMany([first, second, third]);
    feedItemsStore.getState().setFeedItems([item]);
    let feedRequested!: () => void;
    const feedStarted = new Promise<void>((resolve) => {
      feedRequested = resolve;
    });
    mocks.requestFullTextForItems.mockImplementation(() => {
      feedRequested();
      return Promise.resolve({ items: [], omitted: [] });
    });
    mocks.getCaptures.mockResolvedValue([]);
    try {
      const hydration = hydrateOfflineBodiesForPage({
        feedItems: [item],
        bookmarks: [first],
      });
      await feedStarted;
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.requestFullTextForItems).toHaveBeenCalledOnce();
      expect(mocks.getCaptures).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      void hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [second] });
      await vi.advanceTimersByTimeAsync(40);
      void hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [third] });
      await vi.advanceTimersByTimeAsync(19);
      expect(mocks.getCaptures).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.getCaptures).toHaveBeenCalledOnce();
      expect(mocks.getCaptures.mock.calls[0]?.[0]).toEqual({
        bookmarkIds: [first.id, second.id, third.id],
      });
      await hydration;
    } finally {
      invalidateOfflineHydration();
      vi.useRealTimers();
    }
  });

  it("reports idle only after the active hydration finishes", async () => {
    const entity = bookmark();
    bookmarksStore.getState().upsert(entity);
    let resolveCaptures!: (captures: unknown[]) => void;
    mocks.getCaptures.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCaptures = resolve;
      }),
    );
    void hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [entity] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let idle = false;
    const readiness = waitForOfflineHydrationIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    resolveCaptures([]);
    await readiness;
    expect(idle).toBe(true);
  });

  it("uses persisted captures before deciding to fetch them again", async () => {
    const entity = bookmark();
    bookmarksStore.getState().upsert(entity);
    type Cache = Pick<
      ReturnType<typeof bookmarkCapturesStore.getState>,
      "capturesDict"
    >;
    const { persist: persistence } =
      bookmarkCapturesStore as typeof bookmarkCapturesStore & {
        persist: {
          getOptions: () => { storage?: PersistStorage<Cache> };
          setOptions: (options: { storage?: PersistStorage<Cache> }) => void;
          rehydrate: () => Promise<void>;
        };
      };
    const previousStorage = persistence.getOptions().storage;
    let finishRead!: (value: StorageValue<Cache>) => void;
    const read = new Promise<StorageValue<Cache>>((resolve) => {
      finishRead = resolve;
    });
    persistence.setOptions({
      storage: { getItem: () => read, setItem: () => {}, removeItem: () => {} },
    });
    const diskHydration = persistence.rehydrate();
    mocks.getCaptures.mockResolvedValue([]);
    const pageHydration = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [entity],
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mocks.getCaptures).not.toHaveBeenCalled();
    } finally {
      finishRead({
        state: {
          capturesDict: {
            [entity.id]: {
              bookmarkId: entity.id,
              contentHtml: "<p>Cached capture</p>",
              contentHash: "capture-hash",
              captureSource: "server-static-fetch",
              extractorVersion: "test",
              sanitizerPolicyVersion: 1,
              capturedAt: now,
            },
          },
        },
      });
      await diskHydration;
      await pageHydration;
      persistence.setOptions({ storage: previousStorage });
    }
    expect(mocks.getCaptures).not.toHaveBeenCalled();
    expect(
      bookmarkCapturesStore.getState().capturesDict[entity.id]?.contentHtml,
    ).toBe("<p>Cached capture</p>");
  });

  it("retries a failed capture fetch on a page that no longer carries it", async () => {
    const entity = bookmark();
    bookmarksStore.getState().upsert(entity);
    mocks.getCaptures.mockRejectedValueOnce(new Error("offline"));
    await hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [entity] });
    expect(
      bookmarkCapturesStore.getState().capturesDict[entity.id],
    ).toBeUndefined();

    const capture = {
      bookmarkId: entity.id,
      contentHtml: "<p>Capture</p>",
      contentHash: "capture-hash",
      captureSource: "server-static-fetch",
      extractorVersion: "test",
      sanitizerPolicyVersion: 1,
      capturedAt: now,
    };
    mocks.getCaptures.mockResolvedValueOnce([capture]);
    await hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [] });
    expect(mocks.getCaptures).toHaveBeenCalledTimes(2);
    expect(bookmarkCapturesStore.getState().capturesDict[entity.id]).toEqual(
      capture,
    );
  });

  it("drops a failed fetch when the entity stops qualifying", async () => {
    const entity = bookmark();
    bookmarksStore.getState().upsert(entity);
    mocks.getCaptures.mockRejectedValueOnce(new Error("offline"));
    await hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [entity] });

    bookmarksStore.getState().upsert({ ...entity, isSaved: false });
    await hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [] });
    expect(mocks.getCaptures).toHaveBeenCalledTimes(1);
  });

  it("never re-requests a body the server already returned empty", async () => {
    const item = feedItem();
    feedItemsStore.getState().setFeedItems([item]);
    mocks.requestFullTextForItems.mockResolvedValue({
      items: [{ id: item.id, body: null, contentSnippet: "" }],
      omitted: [],
    });
    await hydrateOfflineBodiesForPage({ feedItems: [item], bookmarks: [] });
    await hydrateOfflineBodiesForPage({ feedItems: [item], bookmarks: [] });
    expect(mocks.requestFullTextForItems).toHaveBeenCalledTimes(1);
  });

  it("re-requests an omitted body instead of negative caching it", async () => {
    const item = feedItem();
    feedItemsStore.getState().setFeedItems([item]);
    mocks.requestFullTextForItems
      .mockResolvedValueOnce({ items: [], omitted: [item.id] })
      .mockResolvedValueOnce({
        items: [
          {
            id: item.id,
            body: htmlBody("<p>Body</p>"),
            contentSnippet: "body",
          },
        ],
        omitted: [],
      });

    await hydrateOfflineBodiesForPage({ feedItems: [item], bookmarks: [] });

    expect(mocks.requestFullTextForItems).toHaveBeenCalledTimes(2);
    expect(feedItemsStore.getState().feedItemsDict[item.id]?.body).toEqual(
      htmlBody("<p>Body</p>"),
    );
  });

  it("re-requests an empty body once its content hash changes", async () => {
    const item = feedItem();
    feedItemsStore.getState().setFeedItems([item]);
    mocks.requestFullTextForItems.mockResolvedValue({
      items: [{ id: item.id, body: null, contentSnippet: "" }],
      omitted: [],
    });
    await hydrateOfflineBodiesForPage({ feedItems: [item], bookmarks: [] });
    await hydrateOfflineBodiesForPage({ feedItems: [item], bookmarks: [] });
    expect(mocks.requestFullTextForItems).toHaveBeenCalledTimes(1);

    const regenerated = feedItem({ contentHash: "regenerated-hash" });
    feedItemsStore.getState().setFeedItems([regenerated]);
    await hydrateOfflineBodiesForPage({
      feedItems: [regenerated],
      bookmarks: [],
    });
    expect(mocks.requestFullTextForItems).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent page applications into one hydration run", async () => {
    const first = bookmark({ id: "bookmark-a" });
    const second = bookmark({ id: "bookmark-b" });
    bookmarksStore.getState().upsert(first);
    bookmarksStore.getState().upsert(second);
    mocks.getCaptures.mockImplementation(
      ({ bookmarkIds }: { bookmarkIds: string[] }) =>
        Promise.resolve(
          bookmarkIds.map((bookmarkId) => ({
            bookmarkId,
            contentHtml: "<p>Capture</p>",
            contentHash: "capture-hash",
            captureSource: "server-static-fetch",
            extractorVersion: "test",
            sanitizerPolicyVersion: 1,
            capturedAt: now,
          })),
        ),
    );
    const firstRun = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [first],
    });
    const secondRun = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [second],
    });
    expect(secondRun).toBe(firstRun);
    await firstRun;
    expect(mocks.getCaptures).toHaveBeenCalledTimes(1);
    expect(mocks.getCaptures.mock.calls[0]?.[0]).toEqual({
      bookmarkIds: [first.id, second.id],
    });
    expect(
      bookmarkCapturesStore.getState().capturesDict[first.id],
    ).toBeDefined();
    expect(
      bookmarkCapturesStore.getState().capturesDict[second.id],
    ).toBeDefined();
  });

  it("discards an in-flight fulltext response after invalidation", async () => {
    const item = feedItem();
    feedItemsStore.getState().setFeedItems([item]);
    let resolveFulltext: (response: unknown) => void = () => {};
    mocks.requestFullTextForItems.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFulltext = resolve;
      }),
    );
    const hydration = hydrateOfflineBodiesForPage({
      feedItems: [item],
      bookmarks: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    invalidateOfflineHydration();
    resolveFulltext({
      items: [
        {
          id: item.id,
          body: htmlBody("<p>Late body</p>"),
          contentSnippet: "late",
        },
      ],
      omitted: [],
    });
    await hydration;
    expect(feedItemsStore.getState().feedItemsDict[item.id]?.body).toBeNull();
  });

  it("does not resurrect a severed run alongside the newly admitted one", async () => {
    const gated = bookmark({ id: "bookmark-gated" });
    const fresh = bookmark({ id: "bookmark-fresh" });
    const queued = bookmark({ id: "bookmark-queued" });
    bookmarksStore.getState().upsert(gated);
    const deferred: Array<(captures: unknown[]) => void> = [];
    mocks.getCaptures.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(resolve);
        }),
    );
    const severedRun = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [gated],
    });
    await vi.waitFor(() => expect(deferred).toHaveLength(1));
    invalidateOfflineHydration();

    bookmarksStore.getState().upsert(fresh);
    bookmarksStore.getState().upsert(queued);
    const admittedRun = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [fresh],
    });
    expect(admittedRun).not.toBe(severedRun);
    await vi.waitFor(() => expect(deferred).toHaveLength(2));
    // A third application queues a sweep while the admitted run is gated;
    // only the admitted run may pick it up once its fetch resolves.
    void hydrateOfflineBodiesForPage({ feedItems: [], bookmarks: [queued] });
    expect(deferred).toHaveLength(2);

    // The severed run resolves first. It must terminate instead of
    // draining the queued sweep out from under the admitted run.
    deferred[0]?.([]);
    await severedRun;
    expect(mocks.getCaptures).toHaveBeenCalledTimes(2);

    deferred[1]?.([]);
    await vi.waitFor(() => expect(deferred).toHaveLength(3));
    expect(mocks.getCaptures.mock.calls[2]?.[0]).toEqual({
      bookmarkIds: [queued.id],
    });
    deferred[2]?.([]);
    await admittedRun;
    expect(mocks.getCaptures).toHaveBeenCalledTimes(3);
  });

  it("drops a capture whose Bookmark was archived while the request was in flight", async () => {
    const entity = bookmark();
    bookmarksStore.getState().upsert(entity);
    let resolveCaptures: (captures: unknown[]) => void = () => {};
    mocks.getCaptures.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCaptures = resolve;
      }),
    );
    const hydration = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [entity],
    });
    await vi.waitFor(() => expect(mocks.getCaptures).toHaveBeenCalledOnce());
    bookmarksStore.getState().upsert({ ...entity, isRead: true });
    resolveCaptures([
      {
        bookmarkId: entity.id,
        contentHtml: "<p>Archived capture</p>",
        contentHash: "capture-hash",
        captureSource: "server-static-fetch",
        extractorVersion: "test",
        sanitizerPolicyVersion: 1,
        capturedAt: now,
      },
    ]);
    await hydration;
    expect(bookmarkCapturesStore.getState().capturesDict).toEqual({});
  });

  it("discards an in-flight capture response after invalidation", async () => {
    const entity = bookmark();
    bookmarksStore.getState().upsert(entity);
    let resolveCaptures: (captures: unknown[]) => void = () => {};
    mocks.getCaptures.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCaptures = resolve;
      }),
    );
    const hydration = hydrateOfflineBodiesForPage({
      feedItems: [],
      bookmarks: [entity],
    });
    await vi.waitFor(() => expect(mocks.getCaptures).toHaveBeenCalledOnce());
    invalidateOfflineHydration();
    bookmarkCapturesStore.getState().reset();
    resolveCaptures([
      {
        bookmarkId: entity.id,
        contentHtml: "<p>Stale user capture</p>",
        contentHash: "capture-hash",
        captureSource: "server-static-fetch",
        extractorVersion: "test",
        sanitizerPolicyVersion: 1,
        capturedAt: now,
      },
    ]);
    await hydration;
    expect(bookmarkCapturesStore.getState().capturesDict).toEqual({});
  });
});

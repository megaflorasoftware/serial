import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApplicationFeedItem,
  DatabasePageCapture,
} from "~/server/db/schema";
import type { ApplicationBookmark } from "~/server/mixed-content/projection";
import { dataRequestActions } from "~/lib/data/directRequests";
import { bookmarkCapturesStore } from "~/lib/data/bookmarks/capture-store";
import { bookmarksStore } from "~/lib/data/bookmarks/store";
import {
  getMixedScopeKey,
  mixedContentStore,
} from "~/lib/data/mixed-content/store";
import { feedItemsStore } from "~/lib/data/store";
import { feedsStore } from "~/lib/data/feeds/store";
import { loadingActor } from "~/lib/data/loading-machine";
import { advanceMixedContentMembershipRevision } from "~/lib/data/mixed-content/membershipRevision";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  requestPage: vi.fn(),
  requestFullTextForItems: vi.fn(),
  getCaptures: vi.fn(),
  streamingImport: vi.fn(),
}));

vi.mock("~/lib/orpc", () => ({
  orpc: {
    subscription: {
      getStatus: {
        queryOptions: () => ({ queryKey: ["subscription", "getStatus"] }),
      },
    },
  },
  orpcRouterClient: {
    bookmark: { getCaptures: mocks.getCaptures },
    mixedContent: { requestPage: mocks.requestPage },
    initial: {
      requestFullTextForItems: mocks.requestFullTextForItems,
      streamingImport: mocks.streamingImport,
    },
  },
}));

vi.mock("~/lib/query-client", () => ({
  getQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

const now = new Date("2026-08-18T12:00:00.000Z");

function feedItem(): ApplicationFeedItem {
  return {
    id: "feed-item-one",
    feedId: 1,
    contentId: "content-one",
    title: "Article",
    author: "Author",
    url: "https://example.com/article",
    thumbnail: "",
    content: "",
    contentSnippet: "preview",
    contentType: "text",
    isWatched: false,
    isWatchLater: false,
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
  };
}

function bookmark(): ApplicationBookmark {
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
  };
}

const capture: DatabasePageCapture = {
  bookmarkId: "bookmark-one",
  contentHtml: "<p>Saved Bookmark body</p>",
  contentHash: "capture-hash",
  captureSource: "server-static-fetch",
  extractorVersion: "test",
  sanitizerPolicyVersion: 1,
  capturedAt: now,
};

const scope = { type: "view" as const, viewId: 7 };
const contentStatus = {
  saveStatus: "inbox" as const,
  archiveStatus: "unread" as const,
};

describe("direct request transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mixedContentStore.getState().reset();
    feedItemsStore.getState().reset();
    bookmarksStore.getState().reset();
    bookmarkCapturesStore.getState().reset();
    loadingActor.send({ type: "RESET" });
  });

  it("applies a requested mixed-content page from the direct response", async () => {
    mocks.requestPage.mockResolvedValue({
      references: [],
      bookmarks: [],
      feedItems: [],
      cursor: null,
      hasMore: false,
    });

    await dataRequestActions.requestMixedContentPage(scope, contentStatus);

    expect(
      mixedContentStore.getState().scopes[
        getMixedScopeKey(scope, contentStatus)
      ],
    ).toMatchObject({
      scope,
      contentStatus,
      references: [],
      cursor: null,
      hasMore: false,
    });
  });

  it("rejects a direct page when membership changes while the request is in flight", async () => {
    let resolvePage:
      | ((page: {
          references: [];
          bookmarks: [];
          feedItems: ApplicationFeedItem[];
          cursor: null;
          hasMore: false;
        }) => void)
      | undefined;
    mocks.requestPage.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    const request = dataRequestActions.requestMixedContentPage(
      scope,
      contentStatus,
    );
    advanceMixedContentMembershipRevision();
    resolvePage?.({
      references: [],
      bookmarks: [],
      feedItems: [feedItem()],
      cursor: null,
      hasMore: false,
    });
    await request;

    expect(
      feedItemsStore.getState().feedItemsDict["feed-item-one"],
    ).toBeUndefined();
    expect(
      mixedContentStore.getState().scopes[
        getMixedScopeKey(scope, contentStatus)
      ],
    ).toBeUndefined();
  });

  it("applies requested full text from the direct response", async () => {
    vi.useFakeTimers();
    try {
      feedItemsStore.getState().setFeedItems([feedItem()]);
      feedItemsStore.setState({ pendingFulltextItems: ["feed-item-one"] });
      mocks.requestFullTextForItems.mockResolvedValue([
        {
          id: "feed-item-one",
          content: "Complete article body",
          contentSnippet: "Complete preview",
        },
      ]);

      feedItemsStore.getState().scheduleFulltextFetch();
      await vi.advanceTimersByTimeAsync(300);

      expect(
        feedItemsStore.getState().feedItemsDict["feed-item-one"],
      ).toMatchObject({
        content: "Complete article body",
        contentSnippet: "Complete preview",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates missing Saved text bodies after applying a fetched page", async () => {
    const savedFeedItem = { ...feedItem(), isWatchLater: true };
    const savedBookmark = bookmark();
    mocks.requestPage.mockResolvedValue({
      references: [
        {
          entityKind: "feed-item",
          entityId: savedFeedItem.id,
          sectionPlacement: null,
          normalizedAt: now,
        },
        {
          entityKind: "bookmark",
          entityId: savedBookmark.id,
          sectionPlacement: null,
          normalizedAt: now,
        },
      ],
      bookmarks: [savedBookmark],
      feedItems: [savedFeedItem],
      cursor: null,
      hasMore: false,
    });
    mocks.requestFullTextForItems.mockResolvedValue([
      {
        id: savedFeedItem.id,
        content: "Saved Feed body",
        contentSnippet: "Saved Feed preview",
      },
    ]);
    mocks.getCaptures.mockResolvedValue([capture]);

    await dataRequestActions.requestMixedContentPage(scope, {
      saveStatus: "saved",
      archiveStatus: "unread",
    });

    await vi.waitFor(() => {
      expect(mocks.requestFullTextForItems).toHaveBeenCalledWith(
        { itemIds: [savedFeedItem.id] },
        expect.anything(),
      );
      expect(mocks.getCaptures).toHaveBeenCalledWith(
        { bookmarkIds: [savedBookmark.id] },
        expect.anything(),
      );
      expect(
        feedItemsStore.getState().feedItemsDict[savedFeedItem.id]?.content,
      ).toBe("Saved Feed body");
      expect(
        bookmarkCapturesStore.getState().capturesDict[savedBookmark.id],
      ).toEqual(capture);
    });
  });

  it("applies import progress from the direct response stream", async () => {
    const importedFeed = {
      id: 9,
      userId: "user-one",
      name: "Imported",
      url: "https://example.com/feed.xml",
      platform: "website" as const,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    mocks.streamingImport.mockResolvedValue(
      (async function* () {
        yield { type: "import-start" as const, totalFeeds: 1 };
        yield {
          type: "import-feed-inserted" as const,
          feedUrl: importedFeed.url,
          feedId: importedFeed.id,
          feed: importedFeed,
        };
        yield {
          type: "feed-status" as const,
          feedId: importedFeed.id,
          status: "success" as const,
        };
      })(),
    );

    await dataRequestActions.streamingImport([
      { feedUrl: importedFeed.url, categories: [] },
    ]);

    expect(loadingActor.getSnapshot().value).toBe("idle");
    expect(feedItemsStore.getState().feedStatusDict[importedFeed.id]).toBe(
      "success",
    );
    expect(
      feedsStore.getState().feeds.find(({ id }) => id === importedFeed.id),
    ).toMatchObject({ name: "Imported" });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["subscription", "getStatus"],
    });
  });

  describe("streaming import batching", () => {
    function importedFeed(id: number) {
      return {
        id,
        userId: "user-one",
        name: `Imported ${id}`,
        url: `https://example.com/${id}.xml`,
        platform: "website" as const,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
    }

    function countNotifications() {
      const counts = { feeds: 0, feedStatus: 0 };
      const unsubscribeFeeds = feedsStore.subscribe((next, previous) => {
        if (next.feeds !== previous.feeds) counts.feeds += 1;
      });
      const unsubscribeStatus = feedItemsStore.subscribe((next, previous) => {
        if (next.feedStatusDict !== previous.feedStatusDict) {
          counts.feedStatus += 1;
        }
      });
      return {
        counts,
        stop: () => {
          unsubscribeFeeds();
          unsubscribeStatus();
        },
      };
    }

    beforeEach(() => {
      feedsStore.getState().reset();
    });

    it("applies a burst of inserts and statuses as one write per store", async () => {
      const feeds = Array.from({ length: 50 }, (_, index) =>
        importedFeed(index + 1),
      );
      mocks.streamingImport.mockResolvedValue(
        (async function* () {
          yield { type: "import-start" as const, totalFeeds: feeds.length };
          for (const feed of feeds) {
            yield {
              type: "import-feed-inserted" as const,
              feedUrl: feed.url,
              feedId: feed.id,
              feed,
            };
          }
          for (const feed of feeds) {
            yield {
              type: "feed-status" as const,
              feedId: feed.id,
              status: "success" as const,
            };
          }
        })(),
      );
      const notifications = countNotifications();

      await dataRequestActions.streamingImport(
        feeds.map((feed) => ({ feedUrl: feed.url, categories: [] })),
      );
      notifications.stop();

      expect(notifications.counts.feeds).toBe(1);
      // One reset from import-start, then one coalesced status write.
      expect(notifications.counts.feedStatus).toBe(2);
      expect(feedsStore.getState().feeds).toHaveLength(feeds.length);
      expect(
        Object.keys(feedItemsStore.getState().feedStatusDict),
      ).toHaveLength(feeds.length);
      const snapshot = loadingActor.getSnapshot();
      expect(snapshot.value).toBe("idle");
      expect(snapshot.context.completedFeeds).toBe(feeds.length);
      expect(snapshot.context.totalFeeds).toBe(feeds.length);
    });

    it("flushes buffered chunks before completing when the stream fails", async () => {
      const feed = importedFeed(1);
      mocks.streamingImport.mockResolvedValue(
        (async function* () {
          yield { type: "import-start" as const, totalFeeds: 2 };
          yield {
            type: "import-feed-inserted" as const,
            feedUrl: feed.url,
            feedId: feed.id,
            feed,
          };
          await Promise.resolve();
          throw new Error("stream dropped");
        })(),
      );
      const machineStateWhenFeedsLanded: string[] = [];
      const unsubscribe = feedsStore.subscribe((next, previous) => {
        if (next.feeds !== previous.feeds) {
          machineStateWhenFeedsLanded.push(
            String(loadingActor.getSnapshot().value),
          );
        }
      });

      await expect(
        dataRequestActions.streamingImport([
          { feedUrl: feed.url, categories: [] },
        ]),
      ).rejects.toThrow("stream dropped");
      unsubscribe();

      expect(machineStateWhenFeedsLanded).toEqual(["importing"]);
      expect(feedsStore.getState().feedsDict[feed.id]).toMatchObject({
        name: "Imported 1",
      });
      expect(loadingActor.getSnapshot().value).toBe("idle");
    });

    it("keeps statuses and control chunks in server order within a flush", async () => {
      const feeds = [1, 2, 3, 4].map(importedFeed);
      mocks.streamingImport.mockResolvedValue(
        (async function* () {
          yield { type: "import-start" as const, totalFeeds: 4 };
          yield {
            type: "feed-status" as const,
            feedId: 1,
            status: "success" as const,
          };
          yield {
            type: "import-feed-error" as const,
            feedUrl: feeds[1]!.url,
            error: "unreachable",
          };
          yield {
            type: "feed-status" as const,
            feedId: 3,
            status: "empty" as const,
          };
          yield {
            type: "import-limit-warning" as const,
            deactivatedCount: 1,
            maxActiveFeeds: 2,
          };
          yield {
            type: "feed-status" as const,
            feedId: 4,
            status: "success" as const,
          };
        })(),
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      const machineEvents: string[] = [];
      const inspection = loadingActor.system.inspect((event) => {
        if (
          event.type === "@xstate.event" &&
          event.event.type !== "xstate.init"
        ) {
          machineEvents.push(event.event.type);
        }
      });

      await dataRequestActions.streamingImport(
        feeds.map((feed) => ({ feedUrl: feed.url, categories: [] })),
      );
      inspection.unsubscribe();

      // Every control chunk flushes the statuses buffered before it, so the
      // machine sees the server's order even though the whole stream landed
      // in one frame.
      expect(machineEvents).toEqual([
        "IMPORT_START",
        "FEED_STATUS_BATCH",
        "IMPORT_FEED_ERROR",
        "FEED_STATUS_BATCH",
        "IMPORT_LIMIT_WARNING",
        "FEED_STATUS_BATCH",
        "IMPORT_COMPLETE",
      ]);
      const snapshot = loadingActor.getSnapshot();
      expect(snapshot.value).toBe("idle");
      expect(snapshot.context.completedFeeds).toBe(3);
      expect(snapshot.context.importErrors).toBe(1);
      expect([...snapshot.context.failedImportUrls]).toEqual([feeds[1]!.url]);
      expect(snapshot.context.importDeactivatedCount).toBe(1);
      expect(feedItemsStore.getState().feedStatusDict).toEqual({
        1: "success",
        3: "empty",
        4: "success",
      });
    });
  });
});

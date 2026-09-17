import { afterEach, describe, expect, it } from "vitest";

import type {
  ApplicationBookmark,
  MixedContentCursor,
  MixedContentReference,
} from "~/server/mixed-content/projection";
import { bookmarksStore } from "~/lib/data/bookmarks/store";
import {
  clearRetainedEntityPins,
  cursorRetentionKey,
  setRetainedEntityPins,
} from "~/lib/data/page-retention";
import {
  getMixedScopeKey,
  mixedContentStore,
  synchronizeBookmarkBodyRetention,
} from "~/lib/data/mixed-content/store";
import { CONTENT_STATUS_FILTERS } from "~/lib/content-status";

const SCOPE = { type: "view" as const, viewId: 7 };

function cursor(index: number): Exclude<MixedContentCursor, null> {
  return {
    sectionPlacement: null,
    normalizedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    entityKind: "feed-item",
    entityId: `feed-item-${index}`,
  };
}

function references(pageIndex: number): MixedContentReference[] {
  return Array.from({ length: 30 }, (_, itemIndex) => ({
    entityKind: "feed-item" as const,
    entityId: `page-${pageIndex}-item-${itemIndex}`,
    sectionPlacement: null,
    normalizedAt: new Date(Date.UTC(2026, 0, 1, 0, pageIndex, itemIndex)),
  }));
}

function bookmark(id: string): ApplicationBookmark {
  const now = new Date(Date.UTC(2026, 0, 1));
  return {
    id,
    userId: "user-one",
    sourceUrl: `https://example.com/${id}`,
    effectiveUrl: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
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
    title: id,
    description: null,
    author: null,
    siteName: "example.com",
    publishedAt: null,
    iconUrl: null,
    thumbnailUrl: null,
    previewSource: "url",
    captureHash: null,
    capturedAt: null,
    viewIds: [],
    tagIds: [],
  };
}

function bookmarkReference(
  id: string,
  pageIndex: number,
): MixedContentReference {
  return {
    entityKind: "bookmark",
    entityId: id,
    sectionPlacement: null,
    normalizedAt: new Date(Date.UTC(2026, 0, 1, 0, pageIndex)),
  };
}

function applyPages(count: number) {
  for (let pageIndex = 0; pageIndex < count; pageIndex++) {
    mixedContentStore.getState().applyPage({
      scope: SCOPE,
      contentStatus: { saveStatus: "inbox", archiveStatus: "unread" },
      page: {
        references: references(pageIndex),
        bookmarks: [],
        feedItems: [],
        cursor: cursor(pageIndex),
        hasMore: true,
      },
      replacesScope: pageIndex === 0,
    });
  }
}

afterEach(() => {
  mixedContentStore.getState().reset();
  bookmarksStore.getState().reset();
  clearRetainedEntityPins("reader:test");
});

describe("mixed-content page retention", () => {
  it("keeps four status pages distinct for one View", () => {
    for (const [index, contentStatus] of CONTENT_STATUS_FILTERS.entries()) {
      mixedContentStore.getState().applyPage({
        scope: SCOPE,
        contentStatus,
        page: {
          references: references(index).slice(0, 1),
          bookmarks: [],
          feedItems: [],
          cursor: cursor(index),
          hasMore: false,
        },
        replacesScope: true,
      });
    }

    expect(Object.keys(mixedContentStore.getState().scopes).sort()).toEqual([
      "view:7:inbox:archived",
      "view:7:inbox:unread",
      "view:7:saved:archived",
      "view:7:saved:unread",
    ]);
  });

  it("plateaus cursor pages and scope references during repeated pagination", () => {
    applyPages(12);

    const scope =
      mixedContentStore.getState().scopes[
        getMixedScopeKey(SCOPE, {
          saveStatus: "inbox",
          archiveStatus: "unread",
        })
      ];

    expect(scope?.pages).toHaveLength(8);
    expect(scope?.references).toHaveLength(240);
    expect(
      scope?.references.some(({ entityId }) => entityId.startsWith("page-0-")),
    ).toBe(false);
    expect(
      scope?.references.some(({ entityId }) => entityId.startsWith("page-11-")),
    ).toBe(true);
  });

  it("keeps an open reader entity while evicting an otherwise distant page", () => {
    setRetainedEntityPins("reader:test", {
      feedItemIds: ["page-0-item-0"],
    });

    applyPages(12);

    const scope =
      mixedContentStore.getState().scopes[
        getMixedScopeKey(SCOPE, {
          saveStatus: "inbox",
          archiveStatus: "unread",
        })
      ];
    expect(scope?.pages).toHaveLength(8);
    expect(
      scope?.references.some(({ entityId }) => entityId === "page-0-item-0"),
    ).toBe(true);
    expect(
      scope?.references.some(({ entityId }) => entityId.startsWith("page-1-")),
    ).toBe(false);
  });

  it("retains a provisional tail only when the authoritative first page is unchanged", () => {
    applyPages(3);
    const contentStatus = {
      saveStatus: "inbox",
      archiveStatus: "unread",
    } as const;
    const scopeKey = getMixedScopeKey(SCOPE, contentStatus);

    expect(
      mixedContentStore.getState().reconcileFirstPage({
        scope: SCOPE,
        contentStatus,
        page: {
          references: references(0),
          bookmarks: [],
          feedItems: [],
          cursor: cursor(0),
          hasMore: true,
        },
      }),
    ).toEqual({ firstPageChanged: false });
    expect(
      mixedContentStore.getState().scopes[scopeKey]?.references,
    ).toHaveLength(90);

    const changedReferences = references(9);
    expect(
      mixedContentStore.getState().reconcileFirstPage({
        scope: SCOPE,
        contentStatus,
        page: {
          references: changedReferences,
          bookmarks: [],
          feedItems: [],
          cursor: cursor(9),
          hasMore: false,
        },
      }),
    ).toEqual({ firstPageChanged: true });
    expect(mixedContentStore.getState().scopes[scopeKey]?.references).toEqual(
      [...changedReferences].reverse(),
    );
    expect(mixedContentStore.getState().scopes[scopeKey]?.pages).toHaveLength(
      1,
    );
    expect(mixedContentStore.getState().scopes[scopeKey]?.hasMore).toBe(false);
  });

  it("updates first-page pagination authority while retaining an unchanged provisional tail", () => {
    applyPages(3);
    const contentStatus = {
      saveStatus: "inbox",
      archiveStatus: "unread",
    } as const;
    const scopeKey = getMixedScopeKey(SCOPE, contentStatus);
    const nextCursor = cursor(20);

    expect(
      mixedContentStore.getState().reconcileFirstPage({
        scope: SCOPE,
        contentStatus,
        page: {
          references: references(0),
          bookmarks: [],
          feedItems: [],
          cursor: nextCursor,
          hasMore: false,
        },
      }),
    ).toEqual({ firstPageChanged: false });

    const scope = mixedContentStore.getState().scopes[scopeKey];
    expect(scope?.references).toHaveLength(90);
    expect(scope?.cursor).toEqual(nextCursor);
    expect(scope?.hasMore).toBe(false);
    expect(
      scope?.pages.filter((page) => page.requestCursorKey === "root"),
    ).toHaveLength(1);
    expect(
      scope?.pages.find((page) => page.requestCursorKey === "root")
        ?.nextCursorKey,
    ).toBe(cursorRetentionKey(nextCursor));
  });

  it("evicts Bookmark bodies after their last retained page or pin releases them", () => {
    const contentStatus = {
      saveStatus: "inbox",
      archiveStatus: "unread",
    } as const;
    const sharedBookmark = bookmark("shared-bookmark");
    const pinnedBookmark = bookmark("pinned-bookmark");
    bookmarksStore.getState().upsert(pinnedBookmark);
    setRetainedEntityPins("reader:test", {
      bookmarkIds: [pinnedBookmark.id],
    });

    for (let pageIndex = 0; pageIndex < 9; pageIndex++) {
      const pageBookmark = bookmark(`page-${pageIndex}-bookmark`);
      const pageBookmarks = [
        pageBookmark,
        ...(pageIndex === 0 || pageIndex === 8 ? [sharedBookmark] : []),
      ];
      bookmarksStore.getState().upsertMany(pageBookmarks);
      mixedContentStore.getState().applyPage({
        scope: SCOPE,
        contentStatus,
        page: {
          references: pageBookmarks.map((item) =>
            bookmarkReference(item.id, pageIndex),
          ),
          bookmarks: pageBookmarks,
          feedItems: [],
          cursor: cursor(pageIndex),
          hasMore: true,
        },
        replacesScope: pageIndex === 0,
      });
    }

    expect(
      bookmarksStore.getState().getBookmark("page-0-bookmark"),
    ).toBeUndefined();
    expect(bookmarksStore.getState().getBookmark(sharedBookmark.id)).toBe(
      sharedBookmark,
    );
    expect(bookmarksStore.getState().getBookmark(pinnedBookmark.id)).toBe(
      pinnedBookmark,
    );

    clearRetainedEntityPins("reader:test");
    expect(
      bookmarksStore.getState().getBookmark(pinnedBookmark.id),
    ).toBeUndefined();
  });

  it("does not retain a Bookmark upsert with no loaded page or pin owner", () => {
    const orphan = bookmark("orphan-bookmark");
    bookmarksStore.getState().upsert(orphan);

    expect(
      mixedContentStore.getState().reprojectUpsert({
        bookmark: orphan,
        previousBookmark: undefined,
        views: [],
      }),
    ).toEqual([]);
    expect(bookmarksStore.getState().getBookmark(orphan.id)).toBeUndefined();
  });

  it("prunes bodies restored after mixed-page ownership is already known", () => {
    const owned = bookmark("owned-bookmark");
    const stale = bookmark("late-hydration-orphan");
    mixedContentStore.getState().applyPage({
      scope: SCOPE,
      contentStatus: { saveStatus: "saved", archiveStatus: "unread" },
      page: {
        references: [bookmarkReference(owned.id, 0)],
        bookmarks: [owned],
        feedItems: [],
        cursor: null,
        hasMore: false,
      },
      replacesScope: true,
    });

    bookmarksStore.getState().replace({
      [owned.id]: owned,
      [stale.id]: stale,
    });
    synchronizeBookmarkBodyRetention();

    expect(bookmarksStore.getState().getBookmark(owned.id)).toBe(owned);
    expect(bookmarksStore.getState().getBookmark(stale.id)).toBeUndefined();
  });
});

it("retains Bookmark identities and revision across repeated reconciliation upserts", () => {
  const items = Array.from({ length: 300 }, (_, index) =>
    bookmark(`bookmark-${index}`),
  );
  bookmarksStore.getState().upsertMany(items);
  const before = bookmarksStore.getState().snapshot();
  const revision = bookmarksStore.getState().revision;
  bookmarksStore.getState().upsertMany(structuredClone(items));
  expect(bookmarksStore.getState().revision).toBe(revision);
  expect(bookmarksStore.getState().snapshot()).toBe(before);
  bookmarksStore.getState().upsert(structuredClone(items[0]!));
  expect(bookmarksStore.getState().revision).toBe(revision);
  const changed = { ...structuredClone(items[0]!), tagIds: [7] };
  bookmarksStore.getState().upsertMany([changed]);
  expect(bookmarksStore.getState().getBookmark(changed.id)).toEqual(changed);
  expect(bookmarksStore.getState().revision).toBe(revision + 1);
});

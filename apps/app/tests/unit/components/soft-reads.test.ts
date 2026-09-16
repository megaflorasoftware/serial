// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewSection } from "~/components/feed/view-lists/useViewSections";
import type { ApplicationBookmark } from "~/server/mixed-content/projection";
import type { ApplicationFeedItem, ApplicationView } from "~/server/db/schema";
import { useSoftReads } from "~/components/feed/view-lists/useSoftReads";
import {
  getEligibleSoftReadIds,
  retainEligibleSoftReadPositions,
  retainSoftReadPositions,
} from "~/components/feed/view-lists/softReads";
import {
  clearRetainedEntityPins,
  getRetainedEntityPins,
} from "~/lib/data/page-retention";

const state = vi.hoisted(
  (): {
    saveStatus: string;
    bookmarks: Record<string, ApplicationBookmark>;
    feeds: Record<string, ApplicationFeedItem>;
    revision: number;
    categoryFilter: number;
    feedFilter: number;
  } => ({
    saveStatus: "saved",
    bookmarks: {},
    feeds: {},
    revision: 0,
    categoryFilter: -1,
    feedFilter: -1,
  }),
);
const currentView = vi.hoisted(() => ({
  id: 1,
  userId: "user",
  name: "Saved",
  categoryIds: [10],
  feedIds: [1],
  contentFilter: 7,
  daysWindow: 0,
  readStatus: 0,
  layout: "list",
  placement: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: false,
  viewSections: [],
})) as ApplicationView;
const atoms = vi.hoisted(() => ({
  contentStatus: {},
  category: {},
  feed: {},
}));
vi.mock("jotai", () => ({
  useAtomValue: (atom: object) =>
    atom === atoms.contentStatus
      ? { saveStatus: state.saveStatus, archiveStatus: "unread" }
      : atom === atoms.category
        ? state.categoryFilter
        : state.feedFilter,
}));
vi.mock("~/lib/data/atoms", () => ({
  contentStatusFilterAtom: atoms.contentStatus,
  categoryFilterAtom: atoms.category,
  feedFilterAtom: atoms.feed,
}));
vi.mock("~/lib/data/bookmarks/store", () => ({
  bookmarksStore: {
    useRevision: () => state.revision,
    getState: () => ({
      getBookmark: (id: string) => state.bookmarks[id],
      snapshot: () => state.bookmarks,
    }),
  },
}));
vi.mock("~/lib/data/store", () => ({
  useFeedItemsListProjection: () => ({ getItems: () => state.feeds }),
  feedItemsStore: { getState: () => ({ feedItemsDict: state.feeds }) },
}));
vi.mock("~/lib/data/feed-categories", () => ({
  useFeedCategories: () => ({ feedCategories: [] }),
}));
vi.mock("~/lib/data/views", () => ({
  useViews: () => ({ views: [currentView] }),
}));
vi.mock("~/components/feed/view-lists/useViewSections", () => ({
  useViewSections: (_view: ApplicationView | null, ids: string[]) => ({
    computedSections: [section(ids)],
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function section(
  items: string[],
  placement: number | null = null,
): ViewSection {
  return {
    name: "Saved",
    items,
    layout: "list",
    startIndex: 0,
    isUncategorized: placement === null,
    itemType: placement === null ? undefined : "tag",
    itemId: placement ?? undefined,
    placement,
  };
}

const roots: Array<ReturnType<typeof createRoot>> = [];
function mount() {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  let current: ReturnType<typeof useSoftReads>;
  function List({ sections }: { sections: ViewSection[] }) {
    current = useSoftReads(sections, currentView);
    return null;
  }
  return {
    render: (ids: string[], key = "saved:unread") =>
      act(() =>
        root.render(createElement(List, { key, sections: [section(ids)] })),
      ),
    get items() {
      return current.sections.flatMap((entry) => entry.items);
    },
    toggle: (id: string, mutate = () => true) =>
      act(() => {
        current.toggleRead(id, mutate);
      }),
    unmount: () => act(() => root.unmount()),
  };
}

beforeEach(() => {
  state.saveStatus = "saved";
  state.bookmarks = {
    bookmark: {
      id: "bookmark",
      isSaved: true,
      isRead: false,
      viewIds: [currentView.id],
      tagIds: [],
      contentType: "article",
      createdAt: new Date(),
    } as unknown as ApplicationBookmark,
  };
  state.feeds = {
    feed: {
      id: "feed",
      feedId: 1,
      isWatchLater: true,
      isWatched: false,
      platform: "website",
      contentType: "article",
      orientation: null,
      postedAt: new Date(),
    } as unknown as ApplicationFeedItem,
  };
  state.revision++;
  state.categoryFilter = -1;
  state.feedFilter = -1;
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  clearRetainedEntityPins("other");
});

describe("Saved soft reads for a view visit", () => {
  it.each(["feed", "bookmark"])(
    "retains %s through toggles, reordering, and rollback without duplicates",
    (id) => {
      const list = mount();
      list.render(["before", id, "after"]);
      list.toggle(id, () => {
        expect(
          getRetainedEntityPins(id === "feed" ? "feed-item" : "bookmark").has(
            id,
          ),
        ).toBe(true);
        return true;
      });
      list.render(["before", "after"]);
      expect(list.items).toEqual(["before", id, "after"]);
      list.toggle(id);
      list.render([id, "before", "after"]);
      expect(list.items).toEqual(["before", id, "after"]);
      list.render(["before", id, "after"]);
      expect(list.items).toEqual(["before", id, "after"]);
    },
  );

  it("does not retain Inbox items or items removed by another action", () => {
    state.saveStatus = "inbox";
    const list = mount();
    list.render(["feed", "bookmark"]);
    list.toggle("feed");
    list.render([]);
    expect(list.items).toEqual([]);
    expect(getRetainedEntityPins("feed-item").size).toBe(0);
  });

  it("discards retention on scope changes and on leaving the root route", () => {
    const list = mount();
    list.render(["bookmark"]);
    list.toggle("bookmark");
    list.render([]);
    expect(list.items).toEqual(["bookmark"]);
    list.render([], "other-view");
    expect(list.items).toEqual([]);
    expect(getRetainedEntityPins("bookmark").size).toBe(0);
    list.render([], "saved:unread");
    expect(list.items).toEqual([]);
    list.render(["feed"]);
    list.toggle("feed");
    list.unmount();
    expect(getRetainedEntityPins("feed-item").size).toBe(0);
  });

  it("does not retain rejected mutations", () => {
    const list = mount();
    list.render(["bookmark"]);
    list.toggle("bookmark", () => false);
    list.render([]);
    expect(list.items).toEqual([]);
    expect(getRetainedEntityPins("bookmark").size).toBe(0);
  });

  it.each(["unsave", "delete"])(
    "releases retained items after %s",
    (action) => {
      const list = mount();
      list.render(["feed", "bookmark"]);
      list.toggle("feed");
      list.toggle("bookmark");
      list.render([]);
      expect(list.items).toEqual(["feed", "bookmark"]);
      state.bookmarks =
        action === "delete"
          ? {}
          : {
              bookmark: {
                ...state.bookmarks.bookmark!,
                isSaved: false,
              },
            };
      state.feeds =
        action === "delete"
          ? {}
          : {
              feed: { ...state.feeds.feed!, isWatchLater: false },
            };
      state.revision++;
      list.render([]);
      expect(list.items).toEqual([]);
      expect(getRetainedEntityPins("bookmark").size).toBe(0);
      expect(getRetainedEntityPins("feed-item").size).toBe(0);
    },
  );

  it("releases a retained bookmark that leaves the selected Tag", () => {
    state.categoryFilter = 10;
    state.bookmarks.bookmark = {
      ...state.bookmarks.bookmark!,
      tagIds: [10],
    };
    const list = mount();
    list.render(["bookmark"]);
    list.toggle("bookmark");
    list.render([]);
    expect(list.items).toEqual(["bookmark"]);
    expect(getRetainedEntityPins("bookmark").has("bookmark")).toBe(true);

    state.bookmarks.bookmark = {
      ...state.bookmarks.bookmark,
      tagIds: [],
    };
    state.revision++;
    list.render([]);

    expect(list.items).toEqual([]);
    expect(getRetainedEntityPins("bookmark").has("bookmark")).toBe(false);
  });

  it("retains positions in multiple sections while accepting new pages", () => {
    const sections = [section(["a", "c"], 1), section(["e", "new"], 2)];
    const result = retainSoftReadPositions(
      sections,
      new Map([
        ["b", { sectionKey: "tag:1", index: 1 }],
        ["d", { sectionKey: "tag:2", index: 0 }],
      ]),
    );
    expect(result.map((entry) => entry.items)).toEqual([
      ["a", "b", "c"],
      ["d", "e", "new"],
    ]);
    expect(result.map((entry) => entry.startIndex)).toEqual([0, 3]);
  });

  it("drops bookmarks that leave the selected Tag or View", () => {
    const bookmark = {
      ...state.bookmarks.bookmark!,
      tagIds: [10],
      viewIds: [currentView.id],
    };
    const positions = new Map([
      ["bookmark", { sectionKey: "uncategorized", index: 0 }],
    ]);
    const input = {
      positions,
      bookmarksById: { bookmark },
      feedItemsById: {},
      feedCategories: [],
      views: [currentView],
      currentView,
      feedFilter: -1,
      saveStatus: "saved" as const,
    };

    expect(getEligibleSoftReadIds({ ...input, categoryFilter: 10 })).toEqual([
      "bookmark",
    ]);
    expect(
      getEligibleSoftReadIds({
        ...input,
        categoryFilter: 10,
        bookmarksById: { bookmark: { ...bookmark, tagIds: [] } },
      }),
    ).toEqual([]);
    expect(
      getEligibleSoftReadIds({
        ...input,
        categoryFilter: -1,
        bookmarksById: { bookmark: { ...bookmark, tagIds: [] } },
      }),
    ).toEqual(["bookmark"]);
    expect(
      getEligibleSoftReadIds({
        ...input,
        categoryFilter: -1,
        bookmarksById: {
          bookmark: { ...bookmark, tagIds: [], viewIds: [] },
        },
      }),
    ).toEqual([]);
  });

  it("drops feed items that leave the selected View", () => {
    const positions = new Map([
      ["feed", { sectionKey: "uncategorized", index: 0 }],
    ]);
    const input = {
      positions,
      bookmarksById: {},
      feedItemsById: state.feeds,
      feedCategories: [],
      currentView,
      categoryFilter: -1,
      feedFilter: -1,
      saveStatus: "saved" as const,
    };

    expect(getEligibleSoftReadIds({ ...input, views: [currentView] })).toEqual([
      "feed",
    ]);
    const removedFeedView = { ...currentView, feedIds: [] };
    expect(
      getEligibleSoftReadIds({
        ...input,
        currentView: removedFeedView,
        views: [removedFeedView],
      }),
    ).toEqual([]);
  });

  it("drops positions whose assigned section changed or disappeared", () => {
    const positions = new Map([
      ["moved", { sectionKey: "tag:1", index: 0 }],
      ["missing", { sectionKey: "tag:3", index: 1 }],
      ["stable", { sectionKey: "tag:2", index: 2 }],
    ]);
    const eligibleSections = [section([], 1), section(["moved", "stable"], 2)];

    expect([
      ...retainEligibleSoftReadPositions(positions, eligibleSections).keys(),
    ]).toEqual(["stable"]);
  });
});

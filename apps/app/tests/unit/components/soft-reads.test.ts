// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSoftReads } from "~/components/feed/view-lists/useSoftReads";
import { retainSoftReadPositions } from "~/components/feed/view-lists/softReads";
import type { ViewSection } from "~/components/feed/view-lists/useViewSections";
import {
  clearRetainedEntityPins,
  getRetainedEntityPins,
} from "~/lib/data/page-retention";

const state = vi.hoisted(() => ({
  saveStatus: "saved",
  bookmarks: {} as Record<string, { isSaved: boolean }>,
  feeds: {} as Record<string, { isWatchLater: boolean }>,
  revision: 0,
}));
vi.mock("jotai", () => ({
  useAtomValue: () => ({ saveStatus: state.saveStatus }),
}));
vi.mock("~/lib/data/atoms", () => ({ contentStatusFilterAtom: {} }));
vi.mock("~/lib/data/bookmarks/store", () => ({
  bookmarksStore: {
    useRevision: () => state.revision,
    getState: () => ({ getBookmark: (id: string) => state.bookmarks[id] }),
  },
}));
vi.mock("~/lib/data/store", () => ({
  useFeedItemsListProjection: () => ({ getItems: () => state.feeds }),
  feedItemsStore: { getState: () => ({ feedItemsDict: state.feeds }) },
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

const roots: ReturnType<typeof createRoot>[] = [];
function mount() {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  let current: ReturnType<typeof useSoftReads>;
  function List({ sections }: { sections: ViewSection[] }) {
    current = useSoftReads(sections);
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
  state.bookmarks = { bookmark: { isSaved: true } };
  state.feeds = { feed: { isWatchLater: true } };
  state.revision++;
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
        action === "delete" ? {} : { bookmark: { isSaved: false } };
      state.feeds =
        action === "delete" ? {} : { feed: { isWatchLater: false } };
      state.revision++;
      list.render([]);
      expect(list.items).toEqual([]);
      expect(getRetainedEntityPins("bookmark").size).toBe(0);
      expect(getRetainedEntityPins("feed-item").size).toBe(0);
    },
  );

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
});

import { afterEach, describe, expect, it } from "vitest";

import type { ApplicationFeedItem } from "~/server/db/schema";
import {
  clearRetainedEntityPins,
  setRetainedEntityPins,
} from "~/lib/data/page-retention";
import { feedItemsStore, getFeedItemScopeKey } from "~/lib/data/store";
import { getPersistedFeedItemRetentionState } from "~/lib/data/feed-page-retention";
import { CONTENT_STATUS_FILTERS } from "~/lib/content-status";

const SCOPE_KEY = getFeedItemScopeKey("view", 7, CONTENT_STATUS_FILTERS[0]);

function makeItem(pageIndex: number, itemIndex: number): ApplicationFeedItem {
  const id = `page-${pageIndex}-item-${itemIndex}`;
  const date = new Date(Date.UTC(2026, 0, 1, 0, pageIndex, itemIndex));
  return {
    sourceKind: "rss",
    atprotoUri: null,
    bodySource: "rss",
    tags: [],
    id,
    feedId: 7,
    contentId: id,
    title: id,
    author: "Serial test",
    url: `https://example.com/${id}`,
    thumbnail: "",
    sourceCid: null,
    body: null,
    contentSnippet: id,
    contentType: "text",
    isWatched: false,
    isWatchLater: false,
    progress: 0,
    duration: 1,
    orientation: null,
    platform: "website",
    postedAt: date,
    createdAt: date,
    updatedAt: date,
    isWatchedUpdatedAt: null,
    isWatchLaterUpdatedAt: null,
    contentHash: id,
  };
}

const OFFLINE_BODY = {
  form: "html",
  html: "<p>Offline body</p>",
  revision: "offline-revision",
} as const;

function seedAndRetainPages(pageCount: number, retainedBodyId?: string) {
  const items = Array.from({ length: pageCount }, (_page, pageIndex) =>
    Array.from({ length: 30 }, (_item, itemIndex) =>
      (() => {
        const item = makeItem(pageIndex, itemIndex);
        return item.id === retainedBodyId
          ? { ...item, body: OFFLINE_BODY }
          : item;
      })(),
    ),
  );
  feedItemsStore.setState({
    feedItemsDict: Object.fromEntries(
      items.flat().map((item) => [item.id, item]),
    ),
    feedItemsOrder: items.flat().map((item) => item.id),
    retainedFeedItemBodyIds: retainedBodyId ? { [retainedBodyId]: true } : {},
  });
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    feedItemsStore.getState().retainFeedItemPage({
      scopeKey: SCOPE_KEY,
      itemIds: items[pageIndex]!.map((item) => item.id),
      requestCursor: pageIndex === 0 ? null : { id: `cursor-${pageIndex - 1}` },
      nextCursor: { id: `cursor-${pageIndex}` },
      replacesScope: pageIndex === 0,
    });
  }
}

afterEach(() => {
  feedItemsStore.getState().reset();
  clearRetainedEntityPins("reader:test");
});

describe("Feed-item page retention", () => {
  it("does not enumerate the library while applying one progress update", () => {
    const item = makeItem(0, 0);
    let enumerations = 0;
    const items = new Proxy(
      { [item.id]: item },
      {
        ownKeys(target) {
          enumerations++;
          return Reflect.ownKeys(target);
        },
      },
    );
    feedItemsStore.setState({ feedItemsDict: items });
    enumerations = 0;
    feedItemsStore.getState().setFeedItem(item.id, { ...item, progress: 0.5 });
    expect(feedItemsStore.getState().feedItemsDict[item.id]?.progress).toBe(
      0.5,
    );
    expect(enumerations).toBe(0);
  });

  it("retains entity identity when reconciliation repeats an unchanged page", () => {
    const items = Array.from({ length: 300 }, (_, index) => makeItem(0, index));
    feedItemsStore.getState().setFeedItems(items);
    const before = { ...feedItemsStore.getState().feedItemsDict };
    // Network and IndexedDB produce fresh arrays and Date objects.
    feedItemsStore.getState().setFeedItems(structuredClone(items));
    for (const item of items) {
      expect(feedItemsStore.getState().feedItemsDict[item.id]).toBe(
        before[item.id],
      );
    }
    const changed = {
      ...structuredClone(items[0]!),
      title: "Corrected title",
      tags: ["updated"],
    };
    feedItemsStore.getState().setFeedItems([changed]);
    expect(feedItemsStore.getState().feedItemsDict[changed.id]).toEqual(
      changed,
    );
    expect(feedItemsStore.getState().feedItemsDict[changed.id]).not.toBe(
      before[changed.id],
    );
  });

  it("retains all four content-status pages under collision-free identities", () => {
    const state = feedItemsStore.getState();
    for (const [index, contentStatus] of CONTENT_STATUS_FILTERS.entries()) {
      const item = makeItem(index, 0);
      state.setFeedItems([item]);
      state.retainFeedItemPage({
        scopeKey: getFeedItemScopeKey("view", 7, contentStatus),
        itemIds: [item.id],
        requestCursor: null,
        nextCursor: { id: `cursor-${index}` },
        replacesScope: true,
      });
    }

    expect(
      Object.keys(feedItemsStore.getState().retainedFeedPages).sort(),
    ).toEqual([
      "view:7:inbox:archived",
      "view:7:inbox:unread",
      "view:7:saved:archived",
      "view:7:saved:unread",
    ]);
  });

  it("plateaus pages, entities, scope references, and retained bytes", () => {
    seedAndRetainPages(12);

    const state = feedItemsStore.getState();
    expect(state.retainedFeedPages[SCOPE_KEY]).toHaveLength(8);
    expect(state.scopeFeedItemIds[SCOPE_KEY]).toHaveLength(240);
    expect(Object.keys(state.feedItemsDict)).toHaveLength(240);
    expect(state.retainedFeedPageBytes).toBeGreaterThan(0);
    expect(state.scopeFeedItemIds[SCOPE_KEY]).not.toContain("page-0-item-0");
    expect(state.scopeFeedItemIds[SCOPE_KEY]).toContain("page-11-item-29");
  });

  it("does not collect an entity pinned by an open reader", () => {
    setRetainedEntityPins("reader:test", {
      feedItemIds: ["page-0-item-0"],
    });

    seedAndRetainPages(12);

    const state = feedItemsStore.getState();
    expect(state.retainedFeedPages[SCOPE_KEY]).toHaveLength(8);
    expect(state.feedItemsDict["page-0-item-0"]).toBeDefined();
    expect(state.feedItemsDict["page-1-item-0"]).toBeUndefined();
  });

  it("retains a loaded Unread text body without retaining its cursor page", () => {
    const item = makeItem(0, 0);
    seedAndRetainPages(12, item.id);

    const retained = feedItemsStore.getState();
    expect(
      retained.retainedFeedPages[SCOPE_KEY]?.some((page) =>
        page.entityIds.includes(item.id),
      ),
    ).toBe(false);
    expect(retained.feedItemsDict[item.id]?.body).toEqual(OFFLINE_BODY);
  });

  it("drops body retention when the item is archived", () => {
    const item = makeItem(0, 0);
    feedItemsStore
      .getState()
      .setFeedItem(item.id, { ...item, body: OFFLINE_BODY });

    feedItemsStore.getState().setFeedItem(item.id, {
      ...feedItemsStore.getState().feedItemsDict[item.id]!,
      isWatched: true,
    });

    // The live store keeps the body so the online reader can render it...
    expect(feedItemsStore.getState().feedItemsDict[item.id]?.body).toEqual(
      OFFLINE_BODY,
    );
    expect(feedItemsStore.getState().retainedFeedItemBodyIds[item.id]).toBe(
      undefined,
    );
    // ...while the persisted snapshot no longer carries it.
    expect(
      getPersistedFeedItemRetentionState(feedItemsStore.getState())
        .feedItemsDict[item.id]?.body,
    ).toBeNull();
  });
});

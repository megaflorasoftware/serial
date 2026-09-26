import { getDefaultStore } from "jotai";
import { bookmarksStore } from "./bookmarks/store";
import { getMixedContentMembershipRevision } from "./mixed-content/membershipRevision";
import { getMixedScopeKey, mixedContentStore } from "./mixed-content/store";
import { hydrateOfflineBodiesForPage } from "./offline-hydration";
import { feedItemsStore } from "./store";
import { viewsStore } from "./views/store";
import { feedCategoriesStore } from "./feed-categories/store";
import {
  createFeedItemFilterIndex,
  createFeedItemFilterPredicate,
} from "./feed-items/listProjection";
import {
  categoryFilterAtom,
  dateFilterAtom,
  feedFilterAtom,
  UNSELECTED_VIEW_ID,
  viewFilterIdAtom,
} from "./atoms";
import type { ActiveFirstPageResult } from "~/lib/reconciliation";
import type { ApplicationFeedItem } from "~/server/db/schema";

function removeFeedItem(id: string) {
  const state = feedItemsStore.getState();
  if (!state.feedItemsDict[id]) return;
  const feedItemsDict = { ...state.feedItemsDict };
  delete feedItemsDict[id];
  feedItemsStore.setState({
    feedItemsDict,
    feedItemsOrder: state.feedItemsOrder.filter(
      (candidate) => candidate !== id,
    ),
    scopeFeedItemIds: Object.fromEntries(
      Object.entries(state.scopeFeedItemIds).map(([scopeKey, ids]) => [
        scopeKey,
        ids.filter((candidate) => candidate !== id),
      ]),
    ),
    feedItemProjectionRevision: state.feedItemProjectionRevision + 1,
  });
}

function canRetainCursorPages(target: ActiveFirstPageResult["target"]) {
  const retained =
    mixedContentStore.getState().scopes[
      getMixedScopeKey(target.scope, target.contentStatus)
    ];
  if (!retained || retained.pages.length <= 1) return true;

  const { views, viewsDict } = viewsStore.getState();
  const scope = target.scope;
  const view = scope.type === "view" ? viewsDict[scope.viewId] : null;
  if (scope.type === "view" && !view) return false;
  const matches = createFeedItemFilterPredicate({
    contentStatusFilter: target.contentStatus,
    categoryFilter: scope.type === "tag" ? scope.tagId : -1,
    feedFilter: scope.type === "feed" ? scope.feedId : -1,
    viewFilter: view ?? null,
    filterIndex: createFeedItemFilterIndex(
      feedCategoriesStore.getState().feedCategories,
      views,
    ),
  });
  const items = feedItemsStore.getState().feedItemsDict;
  // An unchanged first page cannot establish membership for retained later pages.
  return retained.references.every((reference) => {
    if (reference.entityKind !== "feed-item") return true;
    const item = items[reference.entityId];
    return item !== undefined && matches(item);
  });
}

export function applyReconciliationFirstPage(page: ActiveFirstPageResult) {
  if (page.membershipRevision !== getMixedContentMembershipRevision()) {
    return false;
  }

  const feedItemUpserts: ApplicationFeedItem[] = [];
  for (const diff of page.feedItemDiffs) {
    if (diff.status === "upsert") feedItemUpserts.push(diff.entity);
    if (diff.status === "delete") removeFeedItem(diff.id);
  }
  const bookmarkUpserts = page.bookmarkDiffs.flatMap((diff) =>
    diff.status === "upsert" ? [diff.entity] : [],
  );
  for (const diff of page.bookmarkDiffs) {
    if (diff.status === "delete") bookmarksStore.getState().remove(diff.id);
  }
  feedItemsStore.getState().setFeedItems(feedItemUpserts);
  bookmarksStore.getState().upsertMany(bookmarkUpserts);
  void hydrateOfflineBodiesForPage({
    feedItems: feedItemUpserts,
    bookmarks: bookmarkUpserts,
  });

  const pageResult = mixedContentStore.getState().reconcileFirstPage({
    scope: page.target.scope,
    contentStatus: page.target.contentStatus,
    retainCursorPages: canRetainCursorPages(page.target),
    page: {
      references: page.orderedRefs,
      feedItems: feedItemUpserts,
      bookmarks: bookmarkUpserts,
      cursor: page.cursor,
      hasMore: page.hasMore,
    },
  });
  if (pageResult.replacedScope) {
    feedItemsStore.getState().retainFeedItemPage({
      scopeKey: `mixed:${getMixedScopeKey(
        page.target.scope,
        page.target.contentStatus,
      )}`,
      itemIds: page.orderedRefs.flatMap((reference) =>
        reference.entityKind === "feed-item" ? [reference.entityId] : [],
      ),
      requestCursor: null,
      nextCursor: page.cursor,
      replacesScope: true,
    });
  }
  const atoms = getDefaultStore();
  if (
    atoms.get(viewFilterIdAtom) === UNSELECTED_VIEW_ID &&
    atoms.get(feedFilterAtom) < 0 &&
    atoms.get(categoryFilterAtom) < 0 &&
    page.target.scope.type === "view"
  ) {
    const view = viewsStore.getState().viewsDict[page.target.scope.viewId];
    atoms.set(feedFilterAtom, -1);
    atoms.set(categoryFilterAtom, -1);
    if (view) atoms.set(dateFilterAtom, view.daysWindow);
    atoms.set(viewFilterIdAtom, page.target.scope.viewId);
  }
  return true;
}

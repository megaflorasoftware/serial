import { createStore } from "zustand";
import { persist } from "zustand/middleware";
import { bookmarksStore } from "../bookmarks/store";
import {
  createFeedItemFilterIndex,
  createFeedItemFilterPredicate,
  getItemSectionPlacement,
  hasFeedItemListProjectionChanged,
} from "../feed-items/listProjection";
import { createNormalizedIDBStorage } from "../normalized-idb-storage";
import { createSelectorHooks } from "../createSelectorHooks";
import {
  getRetainedEntityPins,
  onBookmarkRetentionPinsReleased,
} from "../page-retention";
import {
  bookmarkContentStatus,
  bookmarkReference,
  buildProjectionIndexes,
  emptyProjectionIndexes,
  getMixedScopeKey,
  isBookmarkProjectionChange,
  matchesScope,
  matchingLoadedScopeKeys,
  referencesEqual,
  replaceScopeInIndexes,
  uniqueReferences,
  usesGlobalArchivedViewOrder,
} from "./bookmarkProjection";
import {
  getMixedRetentionPins,
  getPersistedMixedContentState,
  mergeRetainedMixedPage,
  mixedReferenceKey,
  replaceRetainedMixedRootPage,
  retainedMixedBookmarkIds,
  retainedMixedReferenceKeys,
  updateBookmarkPageMembership,
  updateReferencePageMembership,
} from "./page-retention";
import type { ProjectionIndexes } from "./bookmarkProjection";
import type {
  LoadedMixedScope,
  PersistedMixedContentState,
} from "./page-retention";
import type {
  ApplicationFeedItem,
  ApplicationView,
  DatabaseFeedCategory,
} from "~/server/db/schema";
import type {
  ApplicationBookmark,
  MixedContentPage,
  MixedContentReference,
  MixedContentScope,
} from "~/server/mixed-content/projection";
import type { ContentStatusFilter } from "~/lib/content-status";
import { buildContentStatusKey } from "~/lib/content-status";
import { selectFeedItemOrderCoordinate } from "~/lib/data/feed-items/orderCoordinate";

export { getMixedScopeKey } from "./bookmarkProjection";
export type { LoadedMixedScope } from "./page-retention";

let bookmarkOwnershipInitialized = false;

function ownedBookmarkIds(scopes: Record<string, LoadedMixedScope>) {
  const ids = getRetainedEntityPins("bookmark");
  for (const scope of Object.values(scopes)) {
    for (const id of retainedMixedBookmarkIds(scope.pages)) ids.add(id);
  }
  return ids;
}

export function hasBookmarkBodyOwner(bookmarkId: string) {
  return ownedBookmarkIds(mixedContentStore.getState().scopes).has(bookmarkId);
}

function pruneBookmarkBodies(
  scopes: Record<string, LoadedMixedScope>,
  candidates: Iterable<string>,
) {
  const ownedIds = ownedBookmarkIds(scopes);
  if (!bookmarkOwnershipInitialized) {
    bookmarkOwnershipInitialized = true;
    bookmarksStore.getState().pruneExcept(ownedIds);
    return;
  }

  bookmarksStore
    .getState()
    .removeMany([...candidates].filter((id) => !ownedIds.has(id)));
}

export function synchronizeBookmarkBodyRetention() {
  bookmarksStore
    .getState()
    .pruneExcept(ownedBookmarkIds(mixedContentStore.getState().scopes));
  bookmarkOwnershipInitialized = true;
}

export function getViewContentAvailability(
  scopes: Record<string, LoadedMixedScope>,
  viewId: number,
  contentStatus: ContentStatusFilter,
) {
  const scope =
    scopes[getMixedScopeKey({ type: "view", viewId }, contentStatus)];
  return scope ? scope.references.length > 0 : undefined;
}

type MixedContentStore = {
  scopes: Record<string, LoadedMixedScope>;
  fetchingScopes: Record<string, boolean>;
  projectionIndexes: ProjectionIndexes;
  projectionIndexesComplete: boolean;
  reset: () => void;
  setScopeFetching: (scopeKey: string, isFetching: boolean) => void;
  applyPage: (input: {
    scope: MixedContentScope;
    contentStatus: ContentStatusFilter;
    page: MixedContentPage;
    replacesScope: boolean;
  }) => void;
  reconcileFirstPage: (input: {
    scope: MixedContentScope;
    contentStatus: ContentStatusFilter;
    page: MixedContentPage;
    retainCursorPages?: boolean;
  }) => { replacedScope: boolean };
  reprojectUpsert: (input: {
    bookmark: ApplicationBookmark;
    previousBookmark: ApplicationBookmark | undefined;
    views: ApplicationView[];
  }) => LoadedMixedScope[];
  reprojectDeletion: (input: { bookmarkId: string }) => LoadedMixedScope[];
  reprojectFeedItems: (input: {
    itemIds: string[];
    previousFeedItems?: Record<string, ApplicationFeedItem | undefined>;
    feedItems: Record<string, ApplicationFeedItem>;
    views: ApplicationView[];
    feedCategories: DatabaseFeedCategory[];
  }) => LoadedMixedScope[];
};

function feedItemReference(input: {
  item: ApplicationFeedItem;
  contentStatus: ContentStatusFilter;
  view: ApplicationView | null;
  filterIndex: ReturnType<typeof createFeedItemFilterIndex>;
}): MixedContentReference {
  const { item, contentStatus, view, filterIndex } = input;
  return {
    entityKind: "feed-item",
    entityId: item.id,
    sectionPlacement:
      view &&
      usesGlobalArchivedViewOrder(
        { type: "view", viewId: view.id },
        contentStatus,
      )
        ? null
        : (getItemSectionPlacement(item, view, filterIndex) ?? null),
    normalizedAt: selectFeedItemOrderCoordinate(contentStatus, item),
  };
}

const vanillaMixedContentStore = createStore<MixedContentStore>()(
  persist<MixedContentStore, [], [], PersistedMixedContentState>(
    (set, get) => ({
      scopes: {},
      fetchingScopes: {},
      projectionIndexes: emptyProjectionIndexes(),
      projectionIndexesComplete: true,
      reset: () => {
        const bookmarkIds = Object.values(get().scopes).flatMap((scope) => [
          ...retainedMixedBookmarkIds(scope.pages),
        ]);
        set({
          scopes: {},
          fetchingScopes: {},
          projectionIndexes: emptyProjectionIndexes(),
          projectionIndexesComplete: true,
        });
        pruneBookmarkBodies({}, bookmarkIds);
        bookmarkOwnershipInitialized = false;
      },
      setScopeFetching: (scopeKey, isFetching) =>
        set((state) => ({
          fetchingScopes: {
            ...state.fetchingScopes,
            [scopeKey]: isFetching,
          },
        })),
      applyPage: ({ scope, contentStatus, page, replacesScope }) => {
        const key = getMixedScopeKey(scope, contentStatus);
        const current = get();
        const existing = current.scopes[key];
        const requestCursor = replacesScope ? null : existing?.cursor;
        const pages = mergeRetainedMixedPage({
          pages: existing?.pages ?? [],
          page,
          requestCursor,
          replacesScope,
        });
        const previousBookmarkIds = retainedMixedBookmarkIds(
          existing?.pages ?? [],
        );
        const retainedKeys = retainedMixedReferenceKeys(pages);
        const pinnedEntityIds = getMixedRetentionPins();
        const nextScope = {
          scope,
          contentStatus,
          references: uniqueReferences(
            replacesScope
              ? page.references
              : [...(existing?.references ?? []), ...page.references],
            {
              usesGlobalEntityIdTieBreak: usesGlobalArchivedViewOrder(
                scope,
                contentStatus,
              ),
            },
          ).filter(
            (reference) =>
              retainedKeys.has(mixedReferenceKey(reference)) ||
              pinnedEntityIds.has(reference.entityId),
          ),
          pages,
          cursor: page.cursor,
          hasMore: page.hasMore,
        };
        const scopes = { ...current.scopes, [key]: nextScope };
        const projectionIndexes = current.projectionIndexesComplete
          ? current.projectionIndexes
          : buildProjectionIndexes(scopes);
        if (current.projectionIndexesComplete) {
          replaceScopeInIndexes({
            indexes: projectionIndexes,
            scopeKey: key,
            previousReferences: existing?.references ?? [],
            nextReferences: nextScope.references,
          });
        }
        set({
          scopes,
          projectionIndexes,
          projectionIndexesComplete: true,
        });
        pruneBookmarkBodies(scopes, previousBookmarkIds);
      },
      reconcileFirstPage: ({
        scope,
        contentStatus,
        page,
        retainCursorPages = true,
      }) => {
        const key = getMixedScopeKey(scope, contentStatus);
        const current = get();
        const existing = current.scopes[key];
        const rootPage = existing?.pages.find(
          (candidate) => candidate.requestCursorKey === "root",
        );
        const referencesByKey = new Map(
          existing?.references.map((reference) => [
            mixedReferenceKey(reference),
            reference,
          ]),
        );
        const retainedFirstPage = rootPage?.value.referenceKeys.flatMap(
          (referenceKey) => {
            const reference = referencesByKey.get(referenceKey);
            return reference ? [reference] : [];
          },
        );
        const firstPageChanged =
          !retainedFirstPage ||
          !referencesEqual(retainedFirstPage, page.references);

        const replacedScope =
          firstPageChanged ||
          !retainCursorPages ||
          !existing ||
          existing.pages.length <= 1;
        if (replacedScope) {
          get().applyPage({
            scope,
            contentStatus,
            page,
            replacesScope: true,
          });
        } else {
          const scopes = {
            ...current.scopes,
            [key]: {
              ...existing,
              pages: replaceRetainedMixedRootPage(existing.pages, page),
              cursor: page.cursor,
              hasMore: page.hasMore,
            },
          };
          set({ scopes });
          pruneBookmarkBodies(scopes, []);
        }

        return { replacedScope };
      },
      reprojectUpsert: ({ bookmark, previousBookmark, views }) => {
        if (!isBookmarkProjectionChange(previousBookmark, bookmark)) return [];

        const current = get();
        const projectionIndexes = current.projectionIndexesComplete
          ? current.projectionIndexes
          : buildProjectionIndexes(current.scopes);
        const candidateKeys = new Set(
          projectionIndexes.bookmarkScopeKeys[bookmark.id] ?? [],
        );
        if (previousBookmark) {
          for (const key of matchingLoadedScopeKeys(
            previousBookmark,
            current.scopes,
            views,
          )) {
            candidateKeys.add(key);
          }
        }
        for (const key of matchingLoadedScopeKeys(
          bookmark,
          current.scopes,
          views,
        )) {
          candidateKeys.add(key);
        }

        let scopes = current.scopes;
        const affected: LoadedMixedScope[] = [];
        for (const key of candidateKeys) {
          const scopeState = current.scopes[key];
          if (!scopeState) continue;
          let references = scopeState.references.filter(
            (reference) =>
              reference.entityKind !== "bookmark" ||
              reference.entityId !== bookmark.id,
          );
          if (
            buildContentStatusKey(bookmarkContentStatus(bookmark)) ===
              buildContentStatusKey(scopeState.contentStatus) &&
            matchesScope(bookmark, scopeState.scope, views)
          ) {
            references = [
              ...references,
              bookmarkReference(bookmark, scopeState, views),
            ];
          }
          references = uniqueReferences(references, {
            usesGlobalEntityIdTieBreak: usesGlobalArchivedViewOrder(
              scopeState.scope,
              scopeState.contentStatus,
            ),
          });
          if (referencesEqual(scopeState.references, references)) continue;

          const nextScope = {
            ...scopeState,
            references,
            pages: updateBookmarkPageMembership(
              scopeState.pages,
              bookmark.id,
              references.some(
                (reference) =>
                  reference.entityKind === "bookmark" &&
                  reference.entityId === bookmark.id,
              ),
            ),
          };
          if (scopes === current.scopes) scopes = { ...current.scopes };
          scopes[key] = nextScope;
          replaceScopeInIndexes({
            indexes: projectionIndexes,
            scopeKey: key,
            previousReferences: scopeState.references,
            nextReferences: references,
          });
          affected.push(nextScope);
        }

        if (affected.length > 0 || !current.projectionIndexesComplete) {
          set({
            scopes,
            projectionIndexes,
            projectionIndexesComplete: true,
          });
        }
        pruneBookmarkBodies(scopes, [bookmark.id]);
        return affected;
      },
      reprojectDeletion: ({ bookmarkId }) => {
        const current = get();
        const projectionIndexes = current.projectionIndexesComplete
          ? current.projectionIndexes
          : buildProjectionIndexes(current.scopes);
        const candidateKeys = new Set(
          projectionIndexes.bookmarkScopeKeys[bookmarkId] ?? [],
        );
        let scopes = current.scopes;
        const affected: LoadedMixedScope[] = [];
        for (const key of candidateKeys) {
          const scopeState = current.scopes[key];
          if (!scopeState) continue;
          const references = scopeState.references.filter(
            (reference) =>
              reference.entityKind !== "bookmark" ||
              reference.entityId !== bookmarkId,
          );
          if (referencesEqual(scopeState.references, references)) continue;

          const nextScope = {
            ...scopeState,
            references,
            pages: updateBookmarkPageMembership(
              scopeState.pages,
              bookmarkId,
              false,
            ),
          };
          if (scopes === current.scopes) scopes = { ...current.scopes };
          scopes[key] = nextScope;
          replaceScopeInIndexes({
            indexes: projectionIndexes,
            scopeKey: key,
            previousReferences: scopeState.references,
            nextReferences: references,
          });
          affected.push(nextScope);
        }
        if (affected.length > 0 || !current.projectionIndexesComplete) {
          set({
            scopes,
            projectionIndexes,
            projectionIndexesComplete: true,
          });
        }
        return affected;
      },
      reprojectFeedItems: ({
        itemIds,
        previousFeedItems = {},
        feedItems,
        views,
        feedCategories,
      }) => {
        const changedItemIds = [...new Set(itemIds)].filter((itemId) => {
          const item = feedItems[itemId];
          return item === undefined
            ? previousFeedItems[itemId] !== undefined
            : hasFeedItemListProjectionChanged(previousFeedItems[itemId], item);
        });
        if (changedItemIds.length === 0) return [];

        const current = get();
        const filterIndex = createFeedItemFilterIndex(feedCategories, views);
        const viewsById = new Map(views.map((view) => [view.id, view]));
        const projectionIndexes = current.projectionIndexesComplete
          ? current.projectionIndexes
          : buildProjectionIndexes(current.scopes);
        let scopes = current.scopes;
        const affected: LoadedMixedScope[] = [];

        for (const [scopeKey, scopeState] of Object.entries(current.scopes)) {
          const scope = scopeState.scope;
          const view =
            scope.type === "view"
              ? (viewsById.get(scope.viewId) ?? null)
              : null;
          if (scope.type === "view" && !view) continue;
          const doesItemBelongToScope = createFeedItemFilterPredicate({
            contentStatusFilter: scopeState.contentStatus,
            categoryFilter: scope.type === "tag" ? scope.tagId : -1,
            feedFilter: scope.type === "feed" ? scope.feedId : -1,
            viewFilter: view,
            filterIndex,
          });
          let references = scopeState.references;
          let pages = scopeState.pages;

          for (const itemId of changedItemIds) {
            const item = feedItems[itemId] ?? previousFeedItems[itemId];
            if (!item) continue;
            const nextReference = feedItemReference({
              item,
              contentStatus: scopeState.contentStatus,
              view,
              filterIndex,
            });
            const belongs =
              feedItems[itemId] !== undefined && doesItemBelongToScope(item);

            references = references.filter(
              (reference) =>
                reference.entityKind !== "feed-item" ||
                reference.entityId !== itemId,
            );
            pages = updateReferencePageMembership(
              pages,
              nextReference,
              belongs,
            );

            if (belongs) {
              references = [...references, nextReference];
            }
          }

          references = uniqueReferences(references, {
            usesGlobalEntityIdTieBreak: usesGlobalArchivedViewOrder(
              scopeState.scope,
              scopeState.contentStatus,
            ),
          });
          if (
            referencesEqual(scopeState.references, references) &&
            pages === scopeState.pages
          ) {
            continue;
          }
          const nextScope = { ...scopeState, references, pages };
          if (scopes === current.scopes) scopes = { ...current.scopes };
          scopes[scopeKey] = nextScope;
          replaceScopeInIndexes({
            indexes: projectionIndexes,
            scopeKey,
            previousReferences: scopeState.references,
            nextReferences: references,
          });
          affected.push(nextScope);
        }

        if (affected.length > 0 || !current.projectionIndexesComplete) {
          set({
            scopes,
            projectionIndexes,
            projectionIndexesComplete: true,
          });
        }
        return affected;
      },
    }),
    {
      name: "serial-mixed-content-store-v2",
      storage: createNormalizedIDBStorage({
        recordFields: ["scopes"],
      }),
      partialize: getPersistedMixedContentState,
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<MixedContentStore>;
        const scopes = Object.fromEntries(
          Object.entries(persisted?.scopes ?? {}).map(([key, scope]) => [
            key,
            { ...scope, pages: scope.pages ?? [] },
          ]),
        );
        return {
          ...currentState,
          ...(persisted ?? {}),
          scopes,
          projectionIndexes: emptyProjectionIndexes(),
          projectionIndexesComplete: Object.keys(scopes).length === 0,
        };
      },
    },
  ),
);

export const mixedContentStore = createSelectorHooks(vanillaMixedContentStore);

onBookmarkRetentionPinsReleased((releasedBookmarkIds) => {
  pruneBookmarkBodies(mixedContentStore.getState().scopes, releasedBookmarkIds);
});

type PersistLifecycle = {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
  };
};

const bookmarkPersistence = bookmarksStore as unknown as PersistLifecycle;
const mixedContentPersistence =
  mixedContentStore as unknown as PersistLifecycle;
const synchronizeHydratedBookmarkRetention = () => {
  if (
    !bookmarkPersistence.persist.hasHydrated() ||
    !mixedContentPersistence.persist.hasHydrated()
  ) {
    return;
  }
  synchronizeBookmarkBodyRetention();
};

bookmarkPersistence.persist.onFinishHydration(
  synchronizeHydratedBookmarkRetention,
);
mixedContentPersistence.persist.onFinishHydration(
  synchronizeHydratedBookmarkRetention,
);
synchronizeHydratedBookmarkRetention();

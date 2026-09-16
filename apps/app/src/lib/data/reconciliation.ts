import { getDefaultStore } from "jotai";
import { unstable_batchedUpdates } from "react-dom";
import { useSyncExternalStore } from "react";
import { bookmarksStore } from "./bookmarks/store";
import { contentCategoriesStore } from "./content-categories/store";
import { feedCategoriesStore } from "./feed-categories/store";
import { getMixedContentMembershipRevision } from "./mixed-content/membershipRevision";
import { feedsStore } from "./feeds/store";
import { loadingActor, updateRefreshCooldown } from "./loading-machine";
import { getMixedScopeKey, mixedContentStore } from "./mixed-content/store";
import { navigationSnapshotStore } from "./navigation/store";
import { rssSummaryAffectsTarget } from "./rssRepair";
import { applyPublishedChunks } from "./subscriptionCoordinator";
import { feedItemsStore } from "./store";
import { viewFeedsStore } from "./view-feeds/store";
import { viewsStore } from "./views/store";
import { applyReconciliationFirstPage } from "./reconciliationPage";
import {
  categoryFilterAtom,
  contentStatusFilterAtom,
  dateFilterAtom,
  feedFilterAtom,
  UNSELECTED_VIEW_ID,
  viewFilterIdAtom,
} from "./atoms";
import type {
  ReconciliationEntityManifestEntry,
  ReconciliationHydrationDomain,
  ReconciliationInput,
  ReconciliationInvalidationSummary,
  ReconciliationPageManifest,
  ReconciliationRequestDescriptor,
  ReconciliationScopeTarget,
  ReconciliationTarget,
} from "~/lib/reconciliation";
import type { PublishedChunk } from "~/server/api/publisher";
import type { RssAttemptSummary, RssTrigger } from "~/lib/rss";
import { orpcRouterClient } from "~/lib/orpc";
import {
  ALL_CONTENT_STATUS_KEYS,
  buildFeedInvalidationSummary,
  createReconciliationRuntime,
  expandInvalidationSummary,
  getBookmarkReconciliationVersion,
  getFeedItemReconciliationVersion,
  getReconciliationTargetKey,
  MAX_TARGETED_RECONCILIATION_TARGETS,
} from "~/lib/reconciliation";
import { ITEMS_PER_PAGE } from "~/server/api/constants";
import { DEFAULT_CONTENT_STATUS_FILTER } from "~/lib/content-status";

type PersistedStore = {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
  };
};

function asPersistedStore(store: unknown) {
  return store as PersistedStore;
}

function reconciliationSessionId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `reconciliation-${Date.now()}-${Math.random()}`;
}

function currentSelection(): ReconciliationScopeTarget | null {
  const atoms = getDefaultStore();
  const contentStatus = atoms.get(contentStatusFilterAtom);
  const feedId = atoms.get(feedFilterAtom);
  if (feedId >= 0) {
    return {
      type: "scope",
      scope: { type: "feed", feedId },
      contentStatus,
    };
  }
  const tagId = atoms.get(categoryFilterAtom);
  if (tagId >= 0) {
    return {
      type: "scope",
      scope: { type: "tag", tagId },
      contentStatus,
    };
  }
  const viewId = atoms.get(viewFilterIdAtom);
  return viewId === UNSELECTED_VIEW_ID
    ? null
    : {
        type: "scope",
        scope: { type: "view", viewId },
        contentStatus,
      };
}

function firstPageManifest(
  target: ReconciliationScopeTarget,
): ReconciliationPageManifest {
  const scope =
    mixedContentStore.getState().scopes[
      getMixedScopeKey(target.scope, target.contentStatus)
    ];
  const rootPage = scope?.pages.find(
    (candidate) => candidate.requestCursorKey === "root",
  );
  if (!scope || !rootPage) return { feedItems: [], bookmarks: [] };

  const referencesByKey = new Map(
    scope.references.map((reference) => [
      `${reference.entityKind}:${reference.entityId}`,
      reference,
    ]),
  );
  const feedItems: ReconciliationEntityManifestEntry[] = [];
  const bookmarks: ReconciliationEntityManifestEntry[] = [];
  // Optimistic membership can exceed a server page. Omitted versions are
  // returned as upserts; cached references and pagination remain intact.
  for (const referenceKey of rootPage.value.referenceKeys.slice(
    0,
    ITEMS_PER_PAGE,
  )) {
    const reference = referencesByKey.get(referenceKey);
    if (!reference) continue;
    if (reference.entityKind === "feed-item") {
      const item = feedItemsStore.getState().feedItemsDict[reference.entityId];
      if (item) {
        feedItems.push({
          id: item.id,
          version: getFeedItemReconciliationVersion(item),
        });
      }
      continue;
    }
    const bookmark = bookmarksStore.getState().getBookmark(reference.entityId);
    if (bookmark) {
      bookmarks.push({
        id: bookmark.id,
        version: getBookmarkReconciliationVersion(bookmark),
      });
    }
  }
  return { feedItems, bookmarks };
}

function buildInput(
  request: ReconciliationRequestDescriptor,
): ReconciliationInput {
  if (request.intent.type === "full") {
    if ("coldContentStatus" in request.intent) {
      return {
        type: "full",
        reconciliationId: request.reconciliationId,
        selection: {
          type: "cold",
          contentStatus: request.intent.coldContentStatus,
          membershipRevision: getMixedContentMembershipRevision(),
        },
      };
    }
    const { selectedScope } = request.intent;
    return {
      type: "full",
      reconciliationId: request.reconciliationId,
      selection: {
        type: "selected",
        scope: selectedScope.scope,
        contentStatus: selectedScope.contentStatus,
        pageManifest: request.intent.discardManifest
          ? { feedItems: [], bookmarks: [] }
          : firstPageManifest(selectedScope),
        membershipRevision: getMixedContentMembershipRevision(),
      },
    };
  }

  return {
    type: "targeted",
    reconciliationId: request.reconciliationId,
    targets: request.intent.targets.map((target) => {
      if (target.type === "scope") {
        return {
          target,
          pageManifest: firstPageManifest(target),
          membershipRevision: getMixedContentMembershipRevision(),
        };
      }
      return target.type === "organization"
        ? { target: { type: "organization" as const } }
        : { target: { type: "navigation" as const } };
    }),
  };
}

function performanceMark(name: string, reconciliationId?: string) {
  if (typeof performance === "undefined") return;
  performance.mark(name);
  if (reconciliationId) performance.mark(`${name}:${reconciliationId}`);
}

function rssRepairMemberships() {
  return {
    viewFeedIds: feedItemsStore.getState().viewFeedIds,
    feedCategories: feedCategoriesStore.getState().feedCategories,
  };
}

function rssSummaryFrom(payloads: PublishedChunk[]) {
  return payloads
    .flatMap((payload) =>
      payload.source === "rss" && payload.chunk.type === "rss-attempt-complete"
        ? [payload.chunk]
        : [],
    )
    .at(-1);
}

function retainedRssTargets(
  summary: RssAttemptSummary,
  activeTarget: ReconciliationScopeTarget | null,
) {
  const activeKey = activeTarget
    ? getReconciliationTargetKey(activeTarget)
    : null;
  return Object.values(mixedContentStore.getState().scopes)
    .map(
      ({ scope, contentStatus }) =>
        ({
          type: "scope",
          scope,
          contentStatus,
        }) satisfies ReconciliationScopeTarget,
    )
    .filter(
      (target) =>
        getReconciliationTargetKey(target) !== activeKey &&
        rssSummaryAffectsTarget(summary, target, rssRepairMemberships()),
    );
}

function retainedScopeTargets(activeTarget: ReconciliationScopeTarget | null) {
  const targets = Object.values(mixedContentStore.getState().scopes).map(
    ({ scope, contentStatus }) =>
      ({
        type: "scope",
        scope,
        contentStatus,
      }) satisfies ReconciliationScopeTarget,
  );
  if (activeTarget) targets.push(activeTarget);
  return [
    ...new Map(
      targets.map((target) => [getReconciliationTargetKey(target), target]),
    ).values(),
  ];
}

function invalidationSummariesFrom(payloads: PublishedChunk[]) {
  return payloads.flatMap((payload) => {
    if (payload.source === "invalidation") return [payload.chunk];
    return payload.invalidation ? [payload.invalidation] : [];
  });
}

function rssDetailInvalidationFrom(payloads: PublishedChunk[]) {
  const feedIds = payloads.flatMap((payload) =>
    payload.source === "rss" &&
    payload.chunk.type === "feed-items" &&
    payload.chunk.feedItems.length > 0
      ? [payload.chunk.feedId]
      : [],
  );
  return feedIds.length > 0
    ? buildFeedInvalidationSummary({
        feedIds,
        contentStatusKeys: ALL_CONTENT_STATUS_KEYS,
      })
    : null;
}

function invalidationEffects(
  summaries: ReconciliationInvalidationSummary[],
  activeTarget: ReconciliationScopeTarget | null,
) {
  if (summaries.length === 0) return null;

  const retainedScopes = retainedScopeTargets(activeTarget);
  const memberships = {
    views: viewsStore.getState().views,
    viewFeedIds: feedItemsStore.getState().viewFeedIds,
    feedCategories: feedCategoriesStore.getState().feedCategories,
  };
  const repairTargets = new Map<string, ReconciliationTarget>();
  const dirtyTargets = new Map<string, ReconciliationTarget>();
  let unknown = false;
  const recordScopeTarget = (target: ReconciliationScopeTarget) => {
    const key = getReconciliationTargetKey(target);
    if (
      target.scope.type === "view" ||
      (activeTarget && key === getReconciliationTargetKey(activeTarget))
    ) {
      repairTargets.set(key, target);
    } else {
      dirtyTargets.set(key, target);
    }
  };

  for (const summary of summaries) {
    for (const domain of summary.domains) {
      const target = { type: domain } satisfies ReconciliationTarget;
      repairTargets.set(getReconciliationTargetKey(target), target);
    }
    const expanded = expandInvalidationSummary({
      summary,
      retainedScopes,
      memberships,
    });
    if (expanded.scopeImpactUnknown) {
      unknown = true;
      for (const target of retainedScopes) recordScopeTarget(target);
      continue;
    }
    for (const target of expanded.scopes) {
      recordScopeTarget(target);
    }
  }

  const eagerTargets = [...repairTargets.values()];
  const fullIntent = activeTarget
    ? ({ type: "full", selectedScope: activeTarget } as const)
    : ({
        type: "full",
        coldContentStatus: DEFAULT_CONTENT_STATUS_FILTER,
      } as const);
  return {
    repairTargets: eagerTargets,
    dirtyTargets: [...dirtyTargets.values()],
    repairIntent: unknown
      ? fullIntent
      : eagerTargets.length > MAX_TARGETED_RECONCILIATION_TARGETS
        ? fullIntent
        : eagerTargets.length > 0
          ? ({ type: "targeted", targets: eagerTargets } as const)
          : undefined,
  };
}

function mutationInvalidationEffects(
  payloads: PublishedChunk[],
  activeTarget: ReconciliationScopeTarget | null,
) {
  return invalidationEffects(invalidationSummariesFrom(payloads), activeTarget);
}

function liveEventTargets(
  payloads: PublishedChunk[],
  activeTarget: ReconciliationScopeTarget | null,
  scopeTargetsHydrated: boolean,
) {
  const targets = new Map<string, ReconciliationTarget>();
  const addTarget = (target: ReconciliationTarget) => {
    targets.set(getReconciliationTargetKey(target), target);
  };
  const rssDetailInvalidation = rssDetailInvalidationFrom(payloads);
  const summaries = [
    ...invalidationSummariesFrom(payloads),
    ...(rssDetailInvalidation ? [rssDetailInvalidation] : []),
  ];
  let affectsAllScopes = summaries.some(
    (summary) => summary.scopeImpact.type === "unknown",
  );

  if (scopeTargetsHydrated) {
    const effects = invalidationEffects(summaries, activeTarget);
    for (const target of [
      ...(effects?.repairTargets ?? []),
      ...(effects?.dirtyTargets ?? []),
    ]) {
      addTarget(target);
    }
  } else {
    for (const summary of summaries) {
      for (const domain of summary.domains) addTarget({ type: domain });
      if (
        summary.scopeImpact.type === "known" &&
        summary.scopeImpact.selectors.length > 0
      ) {
        affectsAllScopes = true;
      }
    }
  }

  const rssSummary = rssSummaryFrom(payloads);
  if (rssSummary && rssSummary.affectedFeeds.length > 0) {
    addTarget({ type: "navigation" });
    if (scopeTargetsHydrated) {
      for (const target of retainedScopeTargets(activeTarget)) {
        if (
          rssSummaryAffectsTarget(rssSummary, target, rssRepairMemberships())
        ) {
          addTarget(target);
        }
      }
    } else {
      affectsAllScopes = true;
    }
  }

  return { targets: [...targets.values()], affectsAllScopes };
}

let manualFullPromise: Promise<void> | null = null;
let resolveManualFull: (() => void) | null = null;
let rejectManualFull: ((error: Error) => void) | null = null;
let supersededManualFullId: string | null = null;

async function requestDueSources(trigger: RssTrigger) {
  const result = await orpcRouterClient.initial.fetchDueSources({ trigger });
  if (result.status !== "background-managed") {
    updateRefreshCooldown(new Date(result.nextRefreshAt));
  }
  return result;
}

const runtime = createReconciliationRuntime<PublishedChunk[]>({
  sessionId: reconciliationSessionId,
  now: () =>
    typeof performance === "undefined" ? Date.now() : performance.now(),
  buildInput,
  openStream: async (input, signal) =>
    orpcRouterClient.initial.reconcileApplicationState(input, { signal }),
  applyAuthoritative: (payload, { reconciliationId }) => {
    switch (payload.type) {
      case "organization":
        unstable_batchedUpdates(() => {
          viewsStore.getState().set(payload.snapshot.views);
          viewsStore.setState({ fetchStatus: "success" });
          feedsStore.getState().set(payload.snapshot.feeds);
          feedsStore.setState({ fetchStatus: "success" });
          contentCategoriesStore.getState().set(payload.snapshot.tags);
          contentCategoriesStore.setState({ fetchStatus: "success" });
          feedCategoriesStore.getState().set(payload.snapshot.feedTags);
          feedCategoriesStore.setState({ fetchStatus: "success" });
          viewFeedsStore.getState().set(payload.snapshot.directViewFeeds);
          viewFeedsStore.setState({ fetchStatus: "success" });
          feedItemsStore.setState({
            hasInitialData: true,
            viewFeedIds: Object.fromEntries(
              payload.snapshot.effectiveViewFeeds.map(({ viewId, feedIds }) => [
                viewId,
                feedIds,
              ]),
            ),
          });
        });
        performanceMark(
          "serial:reconciliation-organization-applied",
          reconciliationId,
        );
        return true;
      case "active-scope": {
        let applied = false;
        unstable_batchedUpdates(() => {
          applied = applyReconciliationFirstPage(payload.page);
        });
        if (applied) {
          performanceMark(
            "serial:reconciliation-active-scope-applied",
            reconciliationId,
          );
        }
        return applied;
      }
      case "navigation":
        navigationSnapshotStore.getState().set(payload.snapshot);
        performanceMark(
          "serial:reconciliation-navigation-applied",
          reconciliationId,
        );
        return true;
    }
  },
  applyLiveEvent: (payloads) => {
    if (
      payloads.some(
        (payload) =>
          payload.source === "rss" && payload.chunk.type === "refresh-start",
      )
    ) {
      performanceMark("serial:rss-start");
    }
    applyPublishedChunks(payloads, {
      refreshNavigation: false,
    });
    const activeTarget = currentSelection();
    const mutationEffects = mutationInvalidationEffects(payloads, activeTarget);
    const summary = rssSummaryFrom(payloads);
    const onlyRssPayloads = payloads.every(({ source }) => source === "rss");
    if (onlyRssPayloads && !summary) {
      const rssDetailInvalidation = rssDetailInvalidationFrom(payloads);
      if (!rssDetailInvalidation) return;
      const effects = invalidationEffects(
        [rssDetailInvalidation],
        activeTarget,
      );
      return {
        dirtyTargets: [
          ...(effects?.repairTargets ?? []),
          ...(effects?.dirtyTargets ?? []),
        ],
      };
    }
    if (summary) {
      performanceMark("serial:rss-complete");
      const repairTargets: ReconciliationTarget[] = [];
      if (summary.affectedFeeds.length > 0) {
        repairTargets.push({ type: "navigation" });
        if (
          activeTarget &&
          rssSummaryAffectsTarget(summary, activeTarget, rssRepairMemberships())
        ) {
          repairTargets.push(activeTarget);
        }
      }
      return {
        repairTargets,
        dirtyTargets: retainedRssTargets(summary, activeTarget),
        repairIntent: { type: "targeted", targets: repairTargets } as const,
      };
    }
    if (mutationEffects) return mutationEffects;
    return;
  },
  getLiveEventTargets: (payloads, { hydratedDomains }) =>
    liveEventTargets(
      payloads,
      currentSelection(),
      hydratedDomains.organization && hydratedDomains["active-scope"],
    ),
  getCurrentSelection: currentSelection,
  mark: performanceMark,
  onParityApplied: ({ automaticRssOwner, reconciliationId }) => {
    loadingActor.send({ type: "RECONCILIATION_COMPLETE" });
    if (resolveManualFull) {
      if (reconciliationId !== supersededManualFullId) resolveManualFull();
      return;
    }
    if (automaticRssOwner === "client") {
      void requestDueSources("automatic").catch((error: unknown) => {
        console.error("Automatic RSS attempt failed", error);
      });
    }
  },
  onRecoveryFailed: () => {
    loadingActor.send({ type: "RECONCILIATION_FAILED" });
  },
  onFullReconciliationFailed: ({ reconciliationId }) => {
    if (reconciliationId !== supersededManualFullId) {
      rejectManualFull?.(new Error("Manual reconciliation failed"));
    }
  },
});

const organizationStores = [
  viewsStore,
  feedsStore,
  contentCategoriesStore,
  feedCategoriesStore,
  viewFeedsStore,
].map(asPersistedStore);
const activeScopeStores = [feedItemsStore, mixedContentStore].map(
  asPersistedStore,
);
const bookmarkStores = [bookmarksStore].map(asPersistedStore);
const navigationStores = [navigationSnapshotStore].map(asPersistedStore);
const cacheUsableStores = [...organizationStores, ...activeScopeStores];
let hydrationCleanups: Array<() => void> = [];
let lifecycleStarted = false;
let runtimeStarted = false;
let initialSubscriptionAttemptFailed = false;

function startRuntime() {
  if (!lifecycleStarted || runtimeStarted) return;
  runtimeStarted = true;
  runtime.start();
}

function observeHydration(stores: PersistedStore[], onHydrated: () => void) {
  let emitted = false;
  const check = () => {
    if (emitted || !stores.every((store) => store.persist.hasHydrated()))
      return;
    emitted = true;
    onHydrated();
  };
  const cleanups = stores.map((store) =>
    store.persist.onFinishHydration(check),
  );
  check();
  return () => cleanups.forEach((cleanup) => cleanup());
}

function observeDomainHydration(
  domain: ReconciliationHydrationDomain,
  stores: PersistedStore[],
) {
  return observeHydration(stores, () => runtime.hydrationComplete(domain));
}

export const dataReconciliation = {
  start() {
    if (lifecycleStarted) return;
    lifecycleStarted = true;
    const atoms = getDefaultStore();
    atoms.set(viewFilterIdAtom, UNSELECTED_VIEW_ID);
    atoms.set(feedFilterAtom, -1);
    atoms.set(categoryFilterAtom, -1);
    atoms.set(contentStatusFilterAtom, DEFAULT_CONTENT_STATUS_FILTER);
    atoms.set(dateFilterAtom, 0);
    loadingActor.send({ type: "INITIAL_LOAD_START" });
    hydrationCleanups = [
      observeDomainHydration("organization", organizationStores),
      observeDomainHydration("active-scope", activeScopeStores),
      observeDomainHydration("bookmarks", bookmarkStores),
      observeDomainHydration("navigation", navigationStores),
      observeHydration(cacheUsableStores, () => runtime.cacheUsable()),
    ];
    if (runtime.getState().sseConnected || initialSubscriptionAttemptFailed) {
      startRuntime();
    }
  },
  stop() {
    hydrationCleanups.forEach((cleanup) => cleanup());
    hydrationCleanups = [];
    runtime.stop();
    lifecycleStarted = false;
    runtimeStarted = false;
    initialSubscriptionAttemptFailed = false;
  },
  activateScope: runtime.activateScope,
  requestManualFull() {
    if (manualFullPromise) return manualFullPromise;
    manualFullPromise = new Promise<void>((resolve, reject) => {
      resolveManualFull = resolve;
      rejectManualFull = reject;
      const inFlight = runtime.getState().inFlight;
      supersededManualFullId =
        inFlight?.intent.type === "full" ? inFlight.reconciliationId : null;
      runtime.requestFull();
    }).finally(() => {
      manualFullPromise = null;
      resolveManualFull = null;
      rejectManualFull = null;
      supersededManualFullId = null;
    });
    return manualFullPromise;
  },
  requestDueSources,
  receivePublishedChunks(payloads: PublishedChunk[]) {
    let start = 0;
    while (start < payloads.length) {
      const rss = payloads[start]?.source === "rss";
      let end = start + 1;
      while (
        end < payloads.length &&
        (payloads[end]?.source === "rss") === rss
      ) {
        end++;
      }
      runtime.receiveLiveEvent(payloads.slice(start, end));
      start = end;
    }
  },
  environmentChanged: runtime.environmentChanged,
  sseConnectionChanged(connected: boolean) {
    runtime.sseConnectionChanged(connected);
    if (connected) {
      initialSubscriptionAttemptFailed = false;
      startRuntime();
    }
  },
  subscriptionAttemptFailed() {
    initialSubscriptionAttemptFailed = true;
    startRuntime();
  },
  getState: runtime.getState,
  subscribe: runtime.subscribe,
};

export function getCurrentReconciliationTarget() {
  return currentSelection();
}

export function getReconciliationTargetStatus(
  target: ReconciliationScopeTarget,
) {
  return runtime.getState().targets[getReconciliationTargetKey(target)]?.status;
}

export type ReconciliationDisplayStatus =
  "idle" | "syncing" | "retrying" | "stale";

function reconciliationDisplayStatus(): ReconciliationDisplayStatus {
  const state = runtime.getState();
  if (state.cacheUsableAt === null && !state.recoveryFailed) return "idle";
  if (state.inFlight) return "syncing";
  if (state.retryPending) return "retrying";
  return state.recoveryFailed ? "stale" : "idle";
}

export function useReconciliationDisplayStatus() {
  return useSyncExternalStore(
    dataReconciliation.subscribe,
    reconciliationDisplayStatus,
    () => "idle" as const,
  );
}

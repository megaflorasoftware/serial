import {
  getReconciliationScopeKey,
  getReconciliationTargetKey,
  getRequiredTargetsForFullReconciliation,
  getTargetDomain,
  MAX_TARGETED_RECONCILIATION_TARGETS,
  RECONCILIATION_HYDRATION_DOMAINS,
  REQUIRED_RECONCILIATION_DOMAINS,
} from "./contracts";
import type {
  AutomaticRssOwner,
  ReconciliationHydrationDomain,
  ReconciliationRequestIntent,
  ReconciliationScopeTarget,
  ReconciliationTarget,
  RequiredReconciliationDomain,
} from "./contracts";
import { DEFAULT_CONTENT_STATUS_FILTER } from "~/lib/content-status";

export type ReconciliationTargetStatus =
  "unverified" | "syncing" | "verified" | "dirty";

export type ReconciliationTargetState = {
  target: ReconciliationTarget;
  status: ReconciliationTargetStatus;
  revision: number;
  requestedReconciliationId: string | null;
  appliedAt: number | null;
  appliedReconciliationId: string | null;
};

export type ReconciliationDomainState = {
  status: ReconciliationTargetStatus;
  appliedAt: number | null;
};

export type ReconciliationRequestDescriptor = {
  reconciliationId: string;
  intent: ReconciliationRequestIntent;
  capturedRevisions: Record<string, number>;
};

type ReconciliationRequestRecord = ReconciliationRequestDescriptor & {
  targets: ReconciliationTarget[];
};

type FullEpoch = {
  reconciliationId: string;
  intent: Extract<ReconciliationRequestIntent, { type: "full" }>;
  selectedScope: ReconciliationScopeTarget | null;
  requiredTargetKeys: string[];
  failedTargetKeys: string[];
  completed: boolean;
  established: boolean;
};

type BufferedAuthoritative<TAuthoritative> = {
  type: "authoritative";
  reconciliationId: string;
  target: ReconciliationTarget;
  targetKeys: string[];
  requiresHydration: ReconciliationHydrationDomain[];
  payload: TAuthoritative;
};

type BufferedLiveEvent<TLiveEvent> = {
  type: "live-event";
  eventId: string;
  targetKeys: string[];
  requiresHydration: ReconciliationHydrationDomain[];
  payload: TLiveEvent;
};

const ALL_SCOPE_TARGETS_KEY = "scope:*";

type BufferedApplication<TAuthoritative, TLiveEvent> =
  BufferedAuthoritative<TAuthoritative> | BufferedLiveEvent<TLiveEvent>;

export type ReconciliationCoordinatorState<
  TAuthoritative = unknown,
  TLiveEvent = unknown,
> = {
  sessionId: string;
  nextReconciliationSequence: number;
  inFlight: ReconciliationRequestDescriptor | null;
  trailingIntent: ReconciliationRequestIntent | null;
  requests: Record<string, ReconciliationRequestRecord>;
  targets: Record<string, ReconciliationTargetState>;
  scopes: Record<string, ReconciliationTargetState>;
  domains: Record<RequiredReconciliationDomain, ReconciliationDomainState>;
  dirtyTargets: Record<string, ReconciliationTarget>;
  hydratedDomains: Record<ReconciliationHydrationDomain, boolean>;
  bufferedApplications: Array<BufferedApplication<TAuthoritative, TLiveEvent>>;
  applyingLiveEvents: Record<string, string[]>;
  latestFullEpoch: FullEpoch | null;
  activeScope: ReconciliationScopeTarget | null;
  cacheUsableAt: number | null;
  serverParityAppliedAt: number | null;
  sseConnected: boolean;
  retryPending: boolean;
  recoveryFailed: boolean;
  retryAt: number | null;
  automaticRssOwner: AutomaticRssOwner | null;
  trustedUpToDate: boolean;
};

export type ReconciliationCommand<TAuthoritative, TLiveEvent> =
  | {
      type: "start-reconciliation";
      request: ReconciliationRequestDescriptor;
    }
  | {
      type: "apply-authoritative";
      reconciliationId: string;
      target: ReconciliationTarget;
      payload: TAuthoritative;
    }
  | {
      type: "apply-live-event";
      eventId: string;
      payload: TLiveEvent;
    };

export type ReconciliationCoordinatorEvent<TAuthoritative, TLiveEvent> =
  | { type: "cache-usable"; at: number }
  | {
      type: "sse-connection-changed";
      connected: boolean;
    }
  | {
      type: "active-scope-changed";
      target: ReconciliationScopeTarget;
    }
  | { type: "retry-scheduled"; at: number | null }
  | { type: "retry-cleared" }
  | {
      type: "hydration-complete";
      domain: ReconciliationHydrationDomain;
    }
  | {
      type: "request-reconciliation";
      intent: ReconciliationRequestIntent;
    }
  | {
      type: "authoritative-received";
      reconciliationId: string;
      target: ReconciliationTarget;
      requiresHydration: ReconciliationHydrationDomain[];
      payload: TAuthoritative;
    }
  | {
      type: "authoritative-applied";
      reconciliationId: string;
      target: ReconciliationTarget;
      at: number;
    }
  | {
      type: "live-event-received";
      eventId: string;
      targets: ReconciliationTarget[];
      affectsAllScopes?: boolean;
      requiresHydration: ReconciliationHydrationDomain[];
      payload?: TLiveEvent;
      invalidates?: ReconciliationTarget[];
      repairIntent?: ReconciliationRequestIntent;
    }
  | { type: "live-event-applied"; eventId: string }
  | {
      type: "targets-dirtied";
      targets: ReconciliationTarget[];
    }
  | {
      type: "request-settled";
      reconciliationId: string;
      at: number;
      failed?: boolean;
      failedTargets?: ReconciliationTarget[];
      epochComplete?: boolean;
      inputRejected?: boolean;
      recoveryIntent?: ReconciliationRequestIntent;
      recoveryFailed?: boolean;
    }
  | {
      type: "automatic-rss-owner-resolved";
      owner: AutomaticRssOwner;
    };

export type ReconciliationCoordinatorTransition<TAuthoritative, TLiveEvent> = {
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>;
  commands: Array<ReconciliationCommand<TAuthoritative, TLiveEvent>>;
};

function initialDomainStates(): Record<
  RequiredReconciliationDomain,
  ReconciliationDomainState
> {
  return Object.fromEntries(
    REQUIRED_RECONCILIATION_DOMAINS.map((domain) => [
      domain,
      { status: "unverified", appliedAt: null },
    ]),
  ) as Record<RequiredReconciliationDomain, ReconciliationDomainState>;
}

function initialHydrationState(): Record<
  ReconciliationHydrationDomain,
  boolean
> {
  return Object.fromEntries(
    RECONCILIATION_HYDRATION_DOMAINS.map((domain) => [domain, false]),
  ) as Record<ReconciliationHydrationDomain, boolean>;
}

export function createReconciliationCoordinatorState<
  TAuthoritative = unknown,
  TLiveEvent = unknown,
>(
  sessionId: string,
): ReconciliationCoordinatorState<TAuthoritative, TLiveEvent> {
  return {
    sessionId,
    nextReconciliationSequence: 1,
    inFlight: null,
    trailingIntent: null,
    requests: {},
    targets: {},
    scopes: {},
    domains: initialDomainStates(),
    dirtyTargets: {},
    hydratedDomains: initialHydrationState(),
    bufferedApplications: [],
    applyingLiveEvents: {},
    latestFullEpoch: null,
    activeScope: null,
    cacheUsableAt: null,
    serverParityAppliedAt: null,
    sseConnected: false,
    retryPending: false,
    recoveryFailed: false,
    retryAt: null,
    automaticRssOwner: null,
    trustedUpToDate: false,
  };
}

function requestTargets(intent: ReconciliationRequestIntent) {
  if (intent.type === "targeted") return intent.targets;
  return "selectedScope" in intent
    ? getRequiredTargetsForFullReconciliation(intent.selectedScope)
    : ([{ type: "organization" }, { type: "navigation" }] as const);
}

function uniqueTargets(targets: readonly ReconciliationTarget[]) {
  return [
    ...new Map(
      targets.map((target) => [getReconciliationTargetKey(target), target]),
    ).values(),
  ];
}

function fullIntentFor<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
): Extract<ReconciliationRequestIntent, { type: "full" }> {
  return state.activeScope
    ? { type: "full", selectedScope: state.activeScope }
    : { type: "full", coldContentStatus: DEFAULT_CONTENT_STATUS_FILTER };
}

function boundedIntent<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  intent: ReconciliationRequestIntent,
): ReconciliationRequestIntent {
  if (intent.type === "full") return intent;
  const targets = uniqueTargets(intent.targets);
  return targets.length > MAX_TARGETED_RECONCILIATION_TARGETS
    ? fullIntentFor(state)
    : { type: "targeted", targets };
}

function mergeRequestIntents<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  current: ReconciliationRequestIntent | null,
  incoming: ReconciliationRequestIntent,
): ReconciliationRequestIntent {
  incoming = boundedIntent(state, incoming);
  if (!current) return incoming;
  if (incoming.type === "full") return incoming;
  if (current.type === "full") return current;
  return boundedIntent(state, {
    type: "targeted",
    targets: uniqueTargets([...current.targets, ...incoming.targets]),
  });
}

function targetState(
  state: ReconciliationCoordinatorState,
  target: ReconciliationTarget,
): ReconciliationTargetState {
  return (
    state.targets[getReconciliationTargetKey(target)] ?? {
      target,
      status: "unverified",
      revision: 0,
      requestedReconciliationId: null,
      appliedAt: null,
      appliedReconciliationId: null,
    }
  );
}

function withTargetState<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  nextTarget: ReconciliationTargetState,
) {
  const targetKey = getReconciliationTargetKey(nextTarget.target);
  const domain = getTargetDomain(nextTarget.target);
  const updatesActiveDomain =
    nextTarget.target.type !== "scope" ||
    (state.activeScope !== null &&
      getReconciliationTargetKey(state.activeScope) === targetKey);
  return {
    ...state,
    targets: { ...state.targets, [targetKey]: nextTarget },
    scopes:
      nextTarget.target.type === "scope"
        ? {
            ...state.scopes,
            [getReconciliationScopeKey(nextTarget.target)]: nextTarget,
          }
        : state.scopes,
    domains: updatesActiveDomain
      ? {
          ...state.domains,
          [domain]: {
            status: nextTarget.status,
            appliedAt: nextTarget.appliedAt,
          },
        }
      : state.domains,
  };
}

function startRequest<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  intent: ReconciliationRequestIntent,
): ReconciliationCoordinatorTransition<TAuthoritative, TLiveEvent> {
  const targets = uniqueTargets(requestTargets(intent));
  const reconciliationId = `${state.sessionId}-${state.nextReconciliationSequence}`;
  const capturedRevisions = Object.fromEntries(
    targets.map((target) => [
      getReconciliationTargetKey(target),
      targetState(state, target).revision,
    ]),
  );
  const descriptor = { reconciliationId, intent, capturedRevisions };
  let nextState: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent> = {
    ...state,
    activeScope:
      intent.type === "full" && "selectedScope" in intent
        ? intent.selectedScope
        : state.activeScope,
    nextReconciliationSequence: state.nextReconciliationSequence + 1,
    inFlight: descriptor,
    requests: {
      ...state.requests,
      [reconciliationId]: { ...descriptor, targets },
    },
  };
  for (const target of targets) {
    nextState = withTargetState(nextState, {
      ...targetState(nextState, target),
      status: "syncing",
      requestedReconciliationId: reconciliationId,
    });
  }
  if (intent.type === "full") {
    nextState = {
      ...nextState,
      latestFullEpoch: {
        reconciliationId,
        intent,
        selectedScope: "selectedScope" in intent ? intent.selectedScope : null,
        requiredTargetKeys: targets.map(getReconciliationTargetKey),
        failedTargetKeys: [],
        completed: false,
        established: false,
      },
      serverParityAppliedAt: null,
    };
  }
  return {
    state: withDerivedTrust(nextState),
    commands: [{ type: "start-reconciliation", request: descriptor }],
  };
}

function enqueueRequest<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  intent: ReconciliationRequestIntent,
): ReconciliationCoordinatorTransition<TAuthoritative, TLiveEvent> {
  if (!state.inFlight) return startRequest(state, boundedIntent(state, intent));
  return {
    state: withDerivedTrust({
      ...state,
      trailingIntent: mergeRequestIntents(state, state.trailingIntent, intent),
    }),
    commands: [],
  };
}

function repairIntentFor<TAuthoritative, TLiveEvent>(
  _state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  targets: ReconciliationTarget[],
): ReconciliationRequestIntent {
  return { type: "targeted", targets: uniqueTargets(targets) };
}

function bindFullScopeTarget<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  reconciliationId: string,
  target: ReconciliationTarget,
) {
  if (target.type !== "scope") return state;
  const request = state.requests[reconciliationId];
  if (
    request?.intent.type !== "full" ||
    request.targets.some(
      (candidate) =>
        getReconciliationTargetKey(candidate) ===
        getReconciliationTargetKey(target),
    )
  ) {
    return state;
  }

  const targetKey = getReconciliationTargetKey(target);
  const currentTarget = targetState(state, target);
  const boundRequest = {
    ...request,
    targets: [...request.targets, target],
    capturedRevisions: {
      ...request.capturedRevisions,
      [targetKey]: currentTarget.revision,
    },
  };
  const activatesColdSelection =
    !("selectedScope" in request.intent) && state.activeScope === null;
  let nextState: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent> = {
    ...state,
    activeScope: activatesColdSelection ? target : state.activeScope,
  };
  nextState = withTargetState(nextState, {
    ...currentTarget,
    status: "syncing",
    requestedReconciliationId: reconciliationId,
  });
  nextState = {
    ...nextState,
    requests: { ...nextState.requests, [reconciliationId]: boundRequest },
    latestFullEpoch:
      nextState.latestFullEpoch?.reconciliationId === reconciliationId
        ? {
            ...nextState.latestFullEpoch,
            selectedScope: activatesColdSelection
              ? target
              : nextState.latestFullEpoch.selectedScope,
            requiredTargetKeys: [
              ...nextState.latestFullEpoch.requiredTargetKeys,
              targetKey,
            ],
          }
        : nextState.latestFullEpoch,
  };
  return markTargetsDirty(nextState, [target], false);
}

function markTargetsDirty<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  targets: readonly ReconciliationTarget[],
  advanceRevision: boolean,
) {
  let nextState = state;
  const dirtyTargets = { ...state.dirtyTargets };
  for (const target of uniqueTargets(targets)) {
    const targetKey = getReconciliationTargetKey(target);
    const current = targetState(nextState, target);
    dirtyTargets[targetKey] = target;
    nextState = withTargetState(nextState, {
      ...current,
      status: "dirty",
      revision: current.revision + (advanceRevision ? 1 : 0),
    });
  }
  return withDerivedTrust({ ...nextState, dirtyTargets });
}

function isHydrated<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  domains: readonly ReconciliationHydrationDomain[],
) {
  return domains.every((domain) => state.hydratedDomains[domain]);
}

function targetKeysOverlap(left: readonly string[], right: Set<string>) {
  const leftAffectsAllScopes = left.includes(ALL_SCOPE_TARGETS_KEY);
  const rightAffectsAllScopes = right.has(ALL_SCOPE_TARGETS_KEY);
  return (
    left.some((key) => right.has(key)) ||
    (leftAffectsAllScopes &&
      [...right].some((key) => key.startsWith("scope:"))) ||
    (rightAffectsAllScopes && left.some((key) => key.startsWith("scope:")))
  );
}

function hasPendingTargetOverlap<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  targetKeys: readonly string[],
) {
  const targetKeySet = new Set(targetKeys);
  return (
    state.bufferedApplications.some((application) =>
      targetKeysOverlap(application.targetKeys, targetKeySet),
    ) ||
    Object.values(state.applyingLiveEvents).some((applyingTargetKeys) =>
      targetKeysOverlap(applyingTargetKeys, targetKeySet),
    )
  );
}

function requestRevisionIsCurrent<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  reconciliationId: string,
  target: ReconciliationTarget,
) {
  const targetKey = getReconciliationTargetKey(target);
  const capturedRevision =
    state.requests[reconciliationId]?.capturedRevisions[targetKey];
  return (
    capturedRevision !== undefined &&
    capturedRevision === targetState(state, target).revision &&
    targetState(state, target).requestedReconciliationId === reconciliationId
  );
}

function bufferApplication<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  application: BufferedApplication<TAuthoritative, TLiveEvent>,
) {
  return withDerivedTrust({
    ...state,
    bufferedApplications: [...state.bufferedApplications, application],
  });
}

function flushBufferedApplications<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
): ReconciliationCoordinatorTransition<TAuthoritative, TLiveEvent> {
  const applyingLiveEvents = { ...state.applyingLiveEvents };
  const blockedTargetKeys = new Set(
    Object.values(applyingLiveEvents).flatMap((targetKeys) => targetKeys),
  );
  const remaining: Array<BufferedApplication<TAuthoritative, TLiveEvent>> = [];
  const commands: Array<ReconciliationCommand<TAuthoritative, TLiveEvent>> = [];
  const staleTargets: ReconciliationTarget[] = [];
  const invalidatedStaleTargetKeys = new Set<string>();
  for (const application of state.bufferedApplications) {
    const blocked =
      !isHydrated(state, application.requiresHydration) ||
      targetKeysOverlap(application.targetKeys, blockedTargetKeys);
    if (blocked) {
      remaining.push(application);
      for (const targetKey of application.targetKeys) {
        blockedTargetKeys.add(targetKey);
      }
      continue;
    }
    if (application.type === "live-event") {
      commands.push({
        type: "apply-live-event",
        eventId: application.eventId,
        payload: application.payload,
      });
      applyingLiveEvents[application.eventId] = application.targetKeys;
      for (const targetKey of application.targetKeys) {
        blockedTargetKeys.add(targetKey);
      }
      continue;
    }
    if (
      !requestRevisionIsCurrent(
        state,
        application.reconciliationId,
        application.target,
      )
    ) {
      staleTargets.push(application.target);
      const targetKey = getReconciliationTargetKey(application.target);
      const capturedRevision =
        state.requests[application.reconciliationId]?.capturedRevisions[
          targetKey
        ];
      if (
        capturedRevision !== undefined &&
        capturedRevision < targetState(state, application.target).revision
      ) {
        invalidatedStaleTargetKeys.add(targetKey);
      }
      continue;
    }
    commands.push({
      type: "apply-authoritative",
      reconciliationId: application.reconciliationId,
      target: application.target,
      payload: application.payload,
    });
  }
  let nextState = withDerivedTrust({
    ...state,
    bufferedApplications: remaining,
    applyingLiveEvents,
  });
  if (staleTargets.length === 0) return { state: nextState, commands };
  nextState = markTargetsDirty(nextState, staleTargets, false);
  const targetsWithoutCurrentRepair = staleTargets.filter((target) => {
    if (!invalidatedStaleTargetKeys.has(getReconciliationTargetKey(target))) {
      return true;
    }
    return (
      !nextState.inFlight ||
      !requestRevisionIsCurrent(
        nextState,
        nextState.inFlight.reconciliationId,
        target,
      )
    );
  });
  if (targetsWithoutCurrentRepair.length === 0) {
    return { state: nextState, commands };
  }
  const queued = enqueueRequest(
    nextState,
    repairIntentFor(nextState, targetsWithoutCurrentRepair),
  );
  return { state: queued.state, commands: [...commands, ...queued.commands] };
}

function fullEpochIsApplied<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
) {
  const fullEpoch = state.latestFullEpoch;
  if (!fullEpoch?.completed || fullEpoch.failedTargetKeys.length > 0) {
    return false;
  }
  return (
    REQUIRED_RECONCILIATION_DOMAINS.every(
      (domain) => state.domains[domain].status === "verified",
    ) &&
    fullEpoch.requiredTargetKeys.every((targetKey) => {
      const target = state.targets[targetKey];
      return target?.status === "verified";
    })
  );
}

function withEstablishedFullParity<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  at: number,
) {
  if (!fullEpochIsApplied(state) || !state.latestFullEpoch) return state;
  return {
    ...state,
    latestFullEpoch: { ...state.latestFullEpoch, established: true },
    serverParityAppliedAt: at,
    recoveryFailed: false,
  };
}

function deriveTrustedUpToDate<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
) {
  const requiredTargetKeys = new Set([
    getReconciliationTargetKey({ type: "organization" }),
    getReconciliationTargetKey({ type: "navigation" }),
    ...(state.activeScope
      ? [getReconciliationTargetKey(state.activeScope)]
      : []),
  ]);
  const hasPendingRequiredApplication =
    state.bufferedApplications.some((application) =>
      targetKeysOverlap(application.targetKeys, requiredTargetKeys),
    ) ||
    Object.values(state.applyingLiveEvents).some((targetKeys) =>
      targetKeysOverlap(targetKeys, requiredTargetKeys),
    );
  return Boolean(
    !state.recoveryFailed &&
    state.cacheUsableAt !== null &&
    state.latestFullEpoch?.established &&
    state.serverParityAppliedAt !== null &&
    state.sseConnected &&
    [...requiredTargetKeys].every(
      (targetKey) => state.dirtyTargets[targetKey] === undefined,
    ) &&
    !hasPendingRequiredApplication,
  );
}

function withDerivedTrust<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
) {
  const trustedUpToDate = deriveTrustedUpToDate(state);
  return state.trustedUpToDate === trustedUpToDate
    ? state
    : { ...state, trustedUpToDate };
}

export function transitionReconciliation<TAuthoritative, TLiveEvent>(
  state: ReconciliationCoordinatorState<TAuthoritative, TLiveEvent>,
  event: ReconciliationCoordinatorEvent<TAuthoritative, TLiveEvent>,
): ReconciliationCoordinatorTransition<TAuthoritative, TLiveEvent> {
  switch (event.type) {
    case "cache-usable":
      return {
        state: withDerivedTrust({ ...state, cacheUsableAt: event.at }),
        commands: [],
      };
    case "sse-connection-changed":
      return {
        state: withDerivedTrust({
          ...state,
          sseConnected: event.connected,
        }),
        commands: [],
      };
    case "active-scope-changed": {
      const target = targetState(state, event.target);
      return {
        state: withDerivedTrust(
          withTargetState({ ...state, activeScope: event.target }, target),
        ),
        commands: [],
      };
    }
    case "retry-scheduled":
      return {
        state: withDerivedTrust({
          ...state,
          retryPending: true,
          retryAt: event.at,
        }),
        commands: [],
      };
    case "retry-cleared":
      return {
        state: withDerivedTrust({
          ...state,
          retryPending: false,
          retryAt: null,
        }),
        commands: [],
      };
    case "automatic-rss-owner-resolved":
      return {
        state: { ...state, automaticRssOwner: event.owner },
        commands: [],
      };
    case "hydration-complete": {
      const hydratedState = {
        ...state,
        hydratedDomains: {
          ...state.hydratedDomains,
          [event.domain]: true,
        },
      };
      return flushBufferedApplications(hydratedState);
    }
    case "request-reconciliation":
      return enqueueRequest(
        markTargetsDirty(state, requestTargets(event.intent), false),
        event.intent,
      );
    case "targets-dirtied":
      return {
        state: withDerivedTrust(markTargetsDirty(state, event.targets, true)),
        commands: [],
      };
    case "authoritative-received": {
      state = bindFullScopeTarget(state, event.reconciliationId, event.target);
      if (
        !requestRevisionIsCurrent(state, event.reconciliationId, event.target)
      ) {
        const dirtyState = markTargetsDirty(state, [event.target], false);
        return enqueueRequest(
          dirtyState,
          repairIntentFor(dirtyState, [event.target]),
        );
      }
      const targetKeys = [getReconciliationTargetKey(event.target)];
      const hasEarlierBlockedTarget = hasPendingTargetOverlap(
        state,
        targetKeys,
      );
      if (
        !isHydrated(state, event.requiresHydration) ||
        hasEarlierBlockedTarget
      ) {
        return {
          state: bufferApplication(state, {
            type: "authoritative",
            reconciliationId: event.reconciliationId,
            target: event.target,
            targetKeys,
            requiresHydration: event.requiresHydration,
            payload: event.payload,
          }),
          commands: [],
        };
      }
      return {
        state,
        commands: [
          {
            type: "apply-authoritative",
            reconciliationId: event.reconciliationId,
            target: event.target,
            payload: event.payload,
          },
        ],
      };
    }
    case "authoritative-applied": {
      if (
        !requestRevisionIsCurrent(state, event.reconciliationId, event.target)
      ) {
        const dirtyState = markTargetsDirty(state, [event.target], false);
        return enqueueRequest(
          dirtyState,
          repairIntentFor(dirtyState, [event.target]),
        );
      }
      const targetKey = getReconciliationTargetKey(event.target);
      const dirtyTargets = { ...state.dirtyTargets };
      delete dirtyTargets[targetKey];
      let nextState = withTargetState(state, {
        ...targetState(state, event.target),
        status: "verified",
        appliedAt: event.at,
        appliedReconciliationId: event.reconciliationId,
      });
      nextState = { ...nextState, dirtyTargets };
      nextState = withEstablishedFullParity(nextState, event.at);
      return { state: withDerivedTrust(nextState), commands: [] };
    }
    case "live-event-received": {
      let nextState = state;
      let commands: Array<ReconciliationCommand<TAuthoritative, TLiveEvent>> =
        [];
      const invalidatedTargets = event.invalidates ?? [];
      if (invalidatedTargets.length > 0) {
        nextState = markTargetsDirty(nextState, invalidatedTargets, true);
        const repairIntent =
          event.repairIntent ?? repairIntentFor(nextState, invalidatedTargets);
        const queued = enqueueRequest(nextState, repairIntent);
        nextState = queued.state;
        commands = queued.commands;
      }
      if (event.payload === undefined) {
        return { state: withDerivedTrust(nextState), commands };
      }
      const targetKeys = [
        ...event.targets.map(getReconciliationTargetKey),
        ...(event.affectsAllScopes ? [ALL_SCOPE_TARGETS_KEY] : []),
      ];
      const hasEarlierBlockedTarget = hasPendingTargetOverlap(
        nextState,
        targetKeys,
      );
      if (
        !isHydrated(nextState, event.requiresHydration) ||
        hasEarlierBlockedTarget
      ) {
        return {
          state: bufferApplication(nextState, {
            type: "live-event",
            eventId: event.eventId,
            targetKeys,
            requiresHydration: event.requiresHydration,
            payload: event.payload,
          }),
          commands,
        };
      }
      return {
        state: withDerivedTrust({
          ...nextState,
          applyingLiveEvents: {
            ...nextState.applyingLiveEvents,
            [event.eventId]: targetKeys,
          },
        }),
        commands: [
          ...commands,
          {
            type: "apply-live-event",
            eventId: event.eventId,
            payload: event.payload,
          },
        ],
      };
    }
    case "live-event-applied": {
      const applyingLiveEvents = { ...state.applyingLiveEvents };
      delete applyingLiveEvents[event.eventId];
      return flushBufferedApplications({ ...state, applyingLiveEvents });
    }
    case "request-settled": {
      let nextState = state;
      let mayEstablishFullParity = false;
      const failedTargetKeys = new Set(
        event.failedTargets?.map(getReconciliationTargetKey) ?? [],
      );
      if (event.failedTargets && event.failedTargets.length > 0) {
        for (const target of event.failedTargets) {
          nextState = bindFullScopeTarget(
            nextState,
            event.reconciliationId,
            target,
          );
        }
        nextState = markTargetsDirty(nextState, event.failedTargets, false);
      }
      if (
        nextState.latestFullEpoch?.reconciliationId ===
          event.reconciliationId &&
        event.epochComplete === true
      ) {
        nextState = {
          ...nextState,
          latestFullEpoch: {
            ...nextState.latestFullEpoch,
            failedTargetKeys: [...failedTargetKeys],
            completed: true,
          },
        };
        mayEstablishFullParity = true;
      } else if (
        event.epochComplete === true &&
        nextState.latestFullEpoch?.completed &&
        nextState.latestFullEpoch.failedTargetKeys.length > 0
      ) {
        const request = nextState.requests[event.reconciliationId];
        const repairedTargetKeys = new Set(
          request?.targets
            .filter((target) => {
              const targetKey = getReconciliationTargetKey(target);
              const current = nextState.targets[targetKey];
              return (
                !failedTargetKeys.has(targetKey) &&
                current?.status === "verified" &&
                current.appliedReconciliationId === event.reconciliationId
              );
            })
            .map(getReconciliationTargetKey) ?? [],
        );
        nextState = {
          ...nextState,
          latestFullEpoch: {
            ...nextState.latestFullEpoch,
            failedTargetKeys: nextState.latestFullEpoch.failedTargetKeys.filter(
              (targetKey) => !repairedTargetKeys.has(targetKey),
            ),
          },
        };
        mayEstablishFullParity = repairedTargetKeys.size > 0;
      }
      if (mayEstablishFullParity) {
        nextState = withEstablishedFullParity(nextState, event.at);
      }
      if (nextState.inFlight?.reconciliationId !== event.reconciliationId) {
        return { state: withDerivedTrust(nextState), commands: [] };
      }
      const trailingIntent = nextState.trailingIntent;
      nextState = {
        ...nextState,
        inFlight: null,
        trailingIntent: null,
        recoveryFailed: event.recoveryFailed ?? nextState.recoveryFailed,
      };
      if (event.recoveryIntent) {
        return startRequest(
          { ...nextState, trailingIntent },
          event.recoveryIntent,
        );
      }
      return trailingIntent && !event.inputRejected
        ? startRequest(nextState, trailingIntent)
        : { state: withDerivedTrust(nextState), commands: [] };
    }
  }
}

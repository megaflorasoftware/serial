import { ORPCError } from "@orpc/client";
import {
  createReconciliationCoordinatorState,
  transitionReconciliation,
} from "./coordinator";
import {
  getReconciliationTargetKey,
  MAX_TARGETED_RECONCILIATION_TARGETS,
} from "./contracts";
import type {
  ReconciliationCommand,
  ReconciliationCoordinatorEvent,
  ReconciliationCoordinatorState,
  ReconciliationRequestDescriptor,
} from "./coordinator";
import type {
  ActiveFirstPageResult,
  OrganizationSnapshot,
  ReconciliationHydrationDomain,
  ReconciliationInput,
  ReconciliationRequestIntent,
  ReconciliationScopeTarget,
  ReconciliationStreamEvent,
  ReconciliationTarget,
  RequiredReconciliationDomain,
} from "./contracts";
import type { NavigationSnapshot } from "~/server/navigation/snapshot";

export type ReconciliationAuthoritativePayload =
  | { type: "organization"; snapshot: OrganizationSnapshot }
  | { type: "active-scope"; page: ActiveFirstPageResult }
  | { type: "navigation"; snapshot: NavigationSnapshot };

export type ReconciliationRuntimeDependencies<TLiveEvent> = {
  sessionId: () => string;
  now: () => number;
  buildInput: (request: ReconciliationRequestDescriptor) => ReconciliationInput;
  openStream: (
    input: ReconciliationInput,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<ReconciliationStreamEvent>>;
  applyAuthoritative: (
    payload: ReconciliationAuthoritativePayload,
    context: { reconciliationId: string; target: ReconciliationTarget },
  ) => boolean;
  applyLiveEvent: (payload: TLiveEvent) =>
    | ReconciliationTarget[]
    | {
        repairTargets?: ReconciliationTarget[];
        dirtyTargets?: ReconciliationTarget[];
        repairIntent?: ReconciliationRequestIntent;
      }
    | void;
  getLiveEventTargets: (
    payload: TLiveEvent,
    context: {
      hydratedDomains: ReconciliationCoordinatorState["hydratedDomains"];
    },
  ) => {
    targets: ReconciliationTarget[];
    affectsAllScopes?: boolean;
  };
  getCurrentSelection: () => ReconciliationScopeTarget | null;
  isVisible?: () => boolean;
  isOnline?: () => boolean;
  mark?: (name: string, reconciliationId?: string) => void;
  onParityApplied?: (input: {
    reconciliationId: string | undefined;
    automaticRssOwner: ReconciliationCoordinatorState["automaticRssOwner"];
  }) => void;
  onFullReconciliationFailed?: (input: { reconciliationId: string }) => void;
  onRecoveryFailed?: () => void;
};

export type ReconciliationRuntime<TLiveEvent> = ReturnType<
  typeof createReconciliationRuntime<TLiveEvent>
>;

function failureTarget(
  event: Extract<ReconciliationStreamEvent["chunk"], { type: "domain-error" }>,
): ReconciliationTarget | undefined {
  if (event.failure.target) return event.failure.target;
  if (event.failure.domain === "organization") return { type: "organization" };
  if (event.failure.domain === "navigation") return { type: "navigation" };
  return undefined;
}

function hydrationFor(payload: ReconciliationAuthoritativePayload) {
  switch (payload.type) {
    case "organization":
      return ["organization"] as ReconciliationHydrationDomain[];
    case "active-scope":
      return [
        "organization",
        "active-scope",
        ...(payload.page.bookmarkDiffs.length > 0 ||
        payload.page.orderedRefs.some(
          (reference) => reference.entityKind === "bookmark",
        )
          ? (["bookmarks"] as const)
          : []),
      ] as ReconciliationHydrationDomain[];
    case "navigation":
      return ["organization", "navigation"] as ReconciliationHydrationDomain[];
  }
}

export function createReconciliationRuntime<TLiveEvent>(
  dependencies: ReconciliationRuntimeDependencies<TLiveEvent>,
) {
  type State = ReconciliationCoordinatorState<
    ReconciliationAuthoritativePayload,
    TLiveEvent
  >;
  type Event = ReconciliationCoordinatorEvent<
    ReconciliationAuthoritativePayload,
    TLiveEvent
  >;
  type Command = ReconciliationCommand<
    ReconciliationAuthoritativePayload,
    TLiveEvent
  >;

  let state: State = createReconciliationCoordinatorState(
    dependencies.sessionId(),
  );
  let started = false;
  let everConnected = false;
  let reconnectRequired = false;
  let completedBeforeFirstConnection = false;
  let liveSequence = 0;
  let retryDelayMs = 1_000;
  let recoveringInvalidInput = false;
  let retryIntent: ReconciliationRequestIntent | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const requestControllers = new Map<string, AbortController>();

  const canRetry = () =>
    (dependencies.isVisible?.() ??
      (typeof document === "undefined" ||
        document.visibilityState !== "hidden")) &&
    (dependencies.isOnline?.() ??
      (typeof navigator === "undefined" || navigator.onLine !== false));

  const clearRetryTimer = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const mergeRetryIntent = (
    current: ReconciliationRequestIntent | null,
    incoming: ReconciliationRequestIntent,
  ): ReconciliationRequestIntent => {
    if (!current || incoming.type === "full") return incoming;
    if (current.type === "full") return current;
    return {
      type: "targeted",
      targets: [
        ...new Map(
          [...current.targets, ...incoming.targets].map((target) => [
            getReconciliationTargetKey(target),
            target,
          ]),
        ).values(),
      ],
    };
  };

  const scheduleRetry = (intent: ReconciliationRequestIntent) => {
    retryIntent = mergeRetryIntent(retryIntent, intent);
    clearRetryTimer();
    if (!canRetry()) {
      send({ type: "retry-scheduled", at: null });
      return;
    }
    const delay = retryDelayMs;
    send({ type: "retry-scheduled", at: dependencies.now() + delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!canRetry()) {
        send({ type: "retry-scheduled", at: null });
        return;
      }
      const pending = retryIntent;
      retryIntent = null;
      send({ type: "retry-cleared" });
      if (pending) {
        send({ type: "request-reconciliation", intent: pending });
      }
    }, delay);
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
  };

  const clearRetry = () => {
    clearRetryTimer();
    retryIntent = null;
    retryDelayMs = 1_000;
    send({ type: "retry-cleared" });
  };

  const successfulRequestCoversRetry = (
    request: ReconciliationRequestDescriptor,
  ) => {
    if (!retryIntent) return true;
    if (retryIntent.type === "full") return request.intent.type === "full";
    const successfulTargetKeys = new Set(
      (state.requests[request.reconciliationId]?.targets ?? []).map(
        getReconciliationTargetKey,
      ),
    );
    return retryIntent.targets.every((target) =>
      successfulTargetKeys.has(getReconciliationTargetKey(target)),
    );
  };

  const clearCoveredRetry = (request: ReconciliationRequestDescriptor) => {
    if (successfulRequestCoversRetry(request)) clearRetry();
  };

  const currentFullIntent = (): ReconciliationRequestIntent => {
    const selectedScope = dependencies.getCurrentSelection();
    const intent: ReconciliationRequestIntent = selectedScope
      ? { type: "full", selectedScope }
      : {
          type: "full",
          coldContentStatus: { saveStatus: "inbox", archiveStatus: "unread" },
        };
    return recoveringInvalidInput
      ? { ...intent, discardManifest: true }
      : intent;
  };

  const retryIntentForFailure = (
    failedTargets: ReconciliationTarget[] | undefined,
    forceFull = false,
  ): ReconciliationRequestIntent => {
    if (
      recoveringInvalidInput ||
      forceFull ||
      !failedTargets ||
      failedTargets.length === 0 ||
      failedTargets.length > MAX_TARGETED_RECONCILIATION_TARGETS
    ) {
      return currentFullIntent();
    }
    return { type: "targeted", targets: failedTargets };
  };

  const execute = (commands: Command[]) => {
    for (const command of commands) {
      if (command.type === "start-reconciliation") {
        dependencies.mark?.(
          "serial:reconciliation-requested",
          command.request.reconciliationId,
        );
        const controller = new AbortController();
        requestControllers.set(command.request.reconciliationId, controller);
        void runRequest(command.request, controller.signal);
        continue;
      }
      if (command.type === "apply-live-event") {
        const effects = dependencies.applyLiveEvent(command.payload);
        const repairTargets = Array.isArray(effects)
          ? effects
          : effects?.repairTargets;
        const dirtyTargets = Array.isArray(effects)
          ? undefined
          : effects?.dirtyTargets;
        const repairIntent = Array.isArray(effects)
          ? undefined
          : effects?.repairIntent;
        if (dirtyTargets && dirtyTargets.length > 0) {
          send({ type: "targets-dirtied", targets: dirtyTargets });
        }
        if ((repairTargets && repairTargets.length > 0) || repairIntent) {
          send({
            type: "live-event-received",
            eventId: `applied:${command.eventId}`,
            targets: repairTargets ?? [],
            invalidates: repairTargets,
            repairIntent,
            requiresHydration: [],
          });
        }
        send({ type: "live-event-applied", eventId: command.eventId });
        continue;
      }
      const applied = dependencies.applyAuthoritative(command.payload, {
        reconciliationId: command.reconciliationId,
        target: command.target,
      });
      if (applied) {
        send({
          type: "authoritative-applied",
          reconciliationId: command.reconciliationId,
          target: command.target,
          at: dependencies.now(),
        });
      } else {
        send({
          type: "live-event-received",
          eventId: `rejected-authority:${command.reconciliationId}`,
          targets: [command.target],
          invalidates: [command.target],
          requiresHydration: [],
        });
      }
    }
  };

  const send = (event: Event) => {
    const previousParity = state.serverParityAppliedAt;
    const transition = transitionReconciliation(state, event);
    state = transition.state;
    notify();
    if (
      previousParity !== state.serverParityAppliedAt &&
      state.serverParityAppliedAt !== null
    ) {
      recoveringInvalidInput = false;
      dependencies.mark?.(
        "serial:server-parity-applied",
        state.latestFullEpoch?.reconciliationId,
      );
      dependencies.onParityApplied?.({
        reconciliationId: state.latestFullEpoch?.reconciliationId,
        automaticRssOwner: state.automaticRssOwner,
      });
    }
    execute(transition.commands);
  };

  const applyCompletedDomain = (
    reconciliationId: string,
    domain: RequiredReconciliationDomain,
    pending: Partial<
      Record<RequiredReconciliationDomain, ReconciliationAuthoritativePayload>
    >,
  ) => {
    const payload = pending[domain];
    if (!payload) return;
    delete pending[domain];
    const requiresHydration = hydrationFor(payload);
    const target: ReconciliationTarget =
      payload.type === "active-scope"
        ? payload.page.target
        : { type: payload.type };
    dependencies.mark?.(
      `serial:reconciliation-${domain}-received`,
      reconciliationId,
    );
    send({
      type: "authoritative-received",
      reconciliationId,
      target,
      requiresHydration,
      payload,
    });
  };

  async function runRequest(
    request: ReconciliationRequestDescriptor,
    signal: AbortSignal,
  ) {
    const pending: Partial<
      Record<RequiredReconciliationDomain, ReconciliationAuthoritativePayload>
    > = {};
    const recoverableFailures = new Map<string, ReconciliationTarget>();
    let settled = false;
    let inputRejected = false;
    try {
      const input = dependencies.buildInput(request);
      const stream = await dependencies.openStream(input, signal);
      for await (const event of stream) {
        if (signal.aborted) return;
        if (event.reconciliationId !== request.reconciliationId) continue;
        const { chunk } = event;
        switch (chunk.type) {
          case "organization-snapshot":
            pending.organization = {
              type: "organization",
              snapshot: chunk.snapshot,
            };
            break;
          case "active-first-page":
            pending["active-scope"] = {
              type: "active-scope",
              page: chunk.page,
            };
            break;
          case "navigation-snapshot":
            pending.navigation = {
              type: "navigation",
              snapshot: chunk.snapshot,
            };
            break;
          case "domain-complete":
            applyCompletedDomain(
              request.reconciliationId,
              chunk.domain,
              pending,
            );
            break;
          case "automatic-rss-owner":
            dependencies.mark?.(`serial:automatic-rss-owner:${chunk.owner}`);
            send({
              type: "automatic-rss-owner-resolved",
              owner: chunk.owner,
            });
            break;
          case "domain-error": {
            const target = failureTarget(chunk);
            if (chunk.failure.phase === "load-view-page" && target) {
              recoverableFailures.set(
                getReconciliationTargetKey(target),
                target,
              );
              continue;
            }
            if (!state.sseConnected && !everConnected) {
              completedBeforeFirstConnection = true;
            }
            send({
              type: "request-settled",
              reconciliationId: request.reconciliationId,
              at: dependencies.now(),
              failed: true,
              failedTargets: target ? [target] : undefined,
            });
            scheduleRetry(
              retryIntentForFailure(
                target ? [target] : undefined,
                chunk.failure.phase === "resolve-selection",
              ),
            );
            if (request.intent.type === "full") {
              dependencies.onFullReconciliationFailed?.({
                reconciliationId: request.reconciliationId,
              });
            }
            settled = true;
            return;
          }
          case "epoch-complete": {
            if (!state.sseConnected && !everConnected) {
              completedBeforeFirstConnection = true;
            }
            const failedTargets = [...recoverableFailures.values()];
            send({
              type: "request-settled",
              reconciliationId: request.reconciliationId,
              at: dependencies.now(),
              failed: failedTargets.length > 0,
              failedTargets:
                failedTargets.length > 0 ? failedTargets : undefined,
              epochComplete: true,
            });
            if (failedTargets.length > 0) {
              scheduleRetry(retryIntentForFailure(failedTargets));
              if (request.intent.type === "full") {
                dependencies.onFullReconciliationFailed?.({
                  reconciliationId: request.reconciliationId,
                });
              }
            } else {
              clearCoveredRetry(request);
            }
            settled = true;
            return;
          }
        }
      }
    } catch (error) {
      inputRejected =
        error instanceof ORPCError &&
        error.code === "BAD_REQUEST" &&
        typeof error.data === "object" &&
        error.data !== null &&
        "issues" in error.data &&
        Array.isArray(error.data.issues);
      if (!signal.aborted) {
        console.error("Reconciliation request failed", error);
      }
    } finally {
      requestControllers.delete(request.reconciliationId);
      if (!settled && !signal.aborted) {
        if (!state.sseConnected && !everConnected) {
          completedBeforeFirstConnection = true;
        }
        const failedTargets = state.requests[request.reconciliationId]?.targets;
        const recoveryFailed = inputRejected && recoveringInvalidInput;
        if (inputRejected) {
          recoveringInvalidInput = true;
          clearRetry();
        }
        send({
          type: "request-settled",
          reconciliationId: request.reconciliationId,
          at: dependencies.now(),
          failed: true,
          failedTargets,
          inputRejected,
          recoveryIntent:
            inputRejected && !recoveryFailed ? currentFullIntent() : undefined,
          recoveryFailed: recoveryFailed || undefined,
        });
        if (inputRejected) {
          if (recoveryFailed) {
            dependencies.onRecoveryFailed?.();
          }
        } else {
          scheduleRetry(retryIntentForFailure(failedTargets));
        }
        if (
          request.intent.type === "full" &&
          (!inputRejected || recoveryFailed)
        ) {
          dependencies.onFullReconciliationFailed?.({
            reconciliationId: request.reconciliationId,
          });
        }
      }
    }
  }

  const requestCurrentFull = () => {
    if (retryIntent) clearRetry();
    send({ type: "request-reconciliation", intent: currentFullIntent() });
  };

  return {
    start() {
      if (started) return;
      started = true;
      requestCurrentFull();
    },
    stop() {
      for (const controller of requestControllers.values()) controller.abort();
      requestControllers.clear();
      clearRetryTimer();
      retryIntent = null;
      retryDelayMs = 1_000;
      recoveringInvalidInput = false;
      started = false;
      everConnected = false;
      reconnectRequired = false;
      completedBeforeFirstConnection = false;
      state = createReconciliationCoordinatorState(dependencies.sessionId());
      notify();
    },
    cacheUsable() {
      send({ type: "cache-usable", at: dependencies.now() });
      dependencies.mark?.("serial:cache-usable");
    },
    hydrationComplete(domain: ReconciliationHydrationDomain) {
      send({ type: "hydration-complete", domain });
    },
    sseConnectionChanged(connected: boolean) {
      const wasConnected = state.sseConnected;
      send({ type: "sse-connection-changed", connected });
      if (!connected) {
        if (wasConnected) reconnectRequired = true;
        return;
      }
      dependencies.mark?.("serial:subscription-connected");
      if (
        reconnectRequired ||
        (!everConnected && completedBeforeFirstConnection)
      ) {
        clearRetry();
        reconnectRequired = false;
        completedBeforeFirstConnection = false;
        requestCurrentFull();
      }
      everConnected = true;
    },
    activateScope(target: ReconciliationScopeTarget) {
      send({ type: "active-scope-changed", target });
      if (
        target.scope.type === "view" &&
        state.inFlight?.intent.type === "full"
      ) {
        return;
      }
      const targetState = state.targets[getReconciliationTargetKey(target)];
      if (
        targetState?.status === "verified" ||
        targetState?.status === "syncing"
      ) {
        return;
      }
      send({
        type: "request-reconciliation",
        intent: { type: "targeted", targets: [target] },
      });
    },
    requestFull: requestCurrentFull,
    environmentChanged() {
      if (!retryIntent) return;
      if (!canRetry()) {
        clearRetryTimer();
        send({ type: "retry-scheduled", at: null });
        return;
      }
      if (retryTimer !== null) return;
      const pending = retryIntent;
      retryIntent = null;
      send({ type: "retry-cleared" });
      send({ type: "request-reconciliation", intent: pending });
    },
    receiveLiveEvent(payload: TLiveEvent) {
      const { targets, affectsAllScopes } = dependencies.getLiveEventTargets(
        payload,
        { hydratedDomains: state.hydratedDomains },
      );
      send({
        type: "live-event-received",
        eventId: `live:${++liveSequence}`,
        targets,
        affectsAllScopes,
        requiresHydration: ["organization", "active-scope", "bookmarks"],
        payload,
      });
    },
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

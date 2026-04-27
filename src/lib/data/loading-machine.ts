import { useSelector } from "@xstate/react";
import { assign, createActor, setup } from "xstate";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

type LoadingMachineEvent =
  // Initial load (app opens, SSE delivers metadata + items)
  | { type: "INITIAL_LOAD_START" }
  | { type: "METADATA_LOADED" }
  | { type: "INITIAL_DATA_COMPLETE" }

  // Background RSS refresh (server fetches RSS after initial-data-complete)
  | { type: "BACKGROUND_REFRESH_START"; totalFeeds: number }

  // Per-feed status (used by background refresh, manual refresh, and import)
  | { type: "FEED_STATUS" }
  | { type: "FEED_STATUS_BATCH"; count: number }

  // Manual refresh (user clicks the refresh button)
  | { type: "MANUAL_REFRESH_REQUEST" }
  | { type: "MANUAL_REFRESH_SERVER_START"; totalFeeds: number }
  | { type: "MANUAL_REFRESH_COMPLETE" }
  | { type: "MANUAL_REFRESH_ERROR" }

  // Import (OPML / CSV feed import)
  | { type: "IMPORT_START"; totalFeeds: number }
  | { type: "IMPORT_FEED_ERROR"; feedUrl: string }
  | {
      type: "IMPORT_LIMIT_WARNING";
      deactivatedCount: number;
      maxActiveFeeds: number;
    }

  // Shared
  | { type: "RESET" };

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type LoadingMachineContext = {
  totalFeeds: number;
  completedFeeds: number;
  importErrors: number;
  failedImportUrls: Set<string>;
  importDeactivatedCount: number;
  importMaxActiveFeeds: number;
};

const INITIAL_CONTEXT: LoadingMachineContext = {
  totalFeeds: 0,
  completedFeeds: 0,
  importErrors: 0,
  failedImportUrls: new Set<string>(),
  importDeactivatedCount: 0,
  importMaxActiveFeeds: 0,
};

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const loadingMachine = setup({
  types: {
    context: {} as LoadingMachineContext,
    events: {} as LoadingMachineEvent,
  },
  guards: {
    // Guard checks *before* the assign action runs, so we add +1 to
    // anticipate the increment that will happen in the same transition.
    allFeedsCompleteAfterStatus: ({ context }) =>
      context.totalFeeds > 0 &&
      context.completedFeeds + 1 + context.importErrors >= context.totalFeeds,

    allFeedsCompleteAfterStatusBatch: ({ context, event }) => {
      const count = event.type === "FEED_STATUS_BATCH" ? event.count : 1;
      return (
        context.totalFeeds > 0 &&
        context.completedFeeds + count + context.importErrors >=
          context.totalFeeds
      );
    },

    allFeedsCompleteAfterError: ({ context }) =>
      context.totalFeeds > 0 &&
      context.completedFeeds + context.importErrors + 1 >= context.totalFeeds,
  },
  actions: {
    incrementCompleted: assign({
      completedFeeds: ({ context }) => context.completedFeeds + 1,
    }),
    incrementCompletedBatch: assign({
      completedFeeds: ({ context, event }) =>
        context.completedFeeds +
        (event.type === "FEED_STATUS_BATCH" ? event.count : 1),
    }),
    recordImportError: assign({
      importErrors: ({ context }) => context.importErrors + 1,
      failedImportUrls: ({ context, event }) => {
        const urls = new Set(context.failedImportUrls);
        if (event.type === "IMPORT_FEED_ERROR") {
          urls.add(event.feedUrl);
        }
        return urls;
      },
    }),
  },
}).createMachine({
  id: "loading",
  initial: "idle",
  context: { ...INITIAL_CONTEXT },
  states: {
    // -----------------------------------------------------------------
    // Idle — nothing is loading
    // -----------------------------------------------------------------
    idle: {
      on: {
        INITIAL_LOAD_START: {
          target: "initialLoad",
          actions: assign({ ...INITIAL_CONTEXT }),
        },
        BACKGROUND_REFRESH_START: {
          target: "backgroundRefresh",
          actions: assign({
            totalFeeds: ({ event }) => event.totalFeeds,
            completedFeeds: 0,
            importErrors: 0,
          }),
        },
        MANUAL_REFRESH_REQUEST: {
          target: "manualRefresh",
          actions: assign({
            totalFeeds: 0,
            completedFeeds: 0,
            importErrors: 0,
          }),
        },
        IMPORT_START: {
          target: "importing",
          actions: assign({
            totalFeeds: ({ event }) => event.totalFeeds,
            completedFeeds: 0,
            importErrors: 0,
            failedImportUrls: () => new Set<string>(),
            importDeactivatedCount: 0,
            importMaxActiveFeeds: 0,
          }),
        },
      },
    },

    // -----------------------------------------------------------------
    // Initial load — loading metadata + feed items on app open
    // -----------------------------------------------------------------
    initialLoad: {
      on: {
        INITIAL_DATA_COMPLETE: { target: "idle" },
        // Import can interrupt initial load
        IMPORT_START: {
          target: "importing",
          actions: assign({
            totalFeeds: ({ event }) => event.totalFeeds,
            completedFeeds: 0,
            importErrors: 0,
            failedImportUrls: () => new Set<string>(),
            importDeactivatedCount: 0,
            importMaxActiveFeeds: 0,
          }),
        },
        RESET: { target: "idle" },
      },
    },

    // -----------------------------------------------------------------
    // Background refresh — server fetches RSS for feeds after initial load
    // Driven by "refresh-start" chunk (source: initial)
    // -----------------------------------------------------------------
    backgroundRefresh: {
      on: {
        FEED_STATUS: [
          {
            guard: "allFeedsCompleteAfterStatus",
            target: "idle",
            actions: "incrementCompleted",
          },
          { actions: "incrementCompleted" },
        ],
        FEED_STATUS_BATCH: [
          {
            guard: "allFeedsCompleteAfterStatusBatch",
            target: "idle",
            actions: "incrementCompletedBatch",
          },
          { actions: "incrementCompletedBatch" },
        ],
        RESET: { target: "idle" },
      },
    },

    // -----------------------------------------------------------------
    // Manual refresh — user clicked the refresh button
    // -----------------------------------------------------------------
    manualRefresh: {
      on: {
        MANUAL_REFRESH_SERVER_START: {
          actions: assign({
            totalFeeds: ({ event }) => event.totalFeeds,
            completedFeeds: 0,
          }),
        },
        FEED_STATUS: { actions: "incrementCompleted" },
        FEED_STATUS_BATCH: { actions: "incrementCompletedBatch" },
        MANUAL_REFRESH_COMPLETE: { target: "idle" },
        MANUAL_REFRESH_ERROR: { target: "idle" },
        RESET: { target: "idle" },
      },
    },

    // -----------------------------------------------------------------
    // Importing — OPML / CSV feed import in progress
    // -----------------------------------------------------------------
    importing: {
      on: {
        FEED_STATUS: [
          {
            guard: "allFeedsCompleteAfterStatus",
            target: "idle",
            actions: "incrementCompleted",
          },
          { actions: "incrementCompleted" },
        ],
        FEED_STATUS_BATCH: [
          {
            guard: "allFeedsCompleteAfterStatusBatch",
            target: "idle",
            actions: "incrementCompletedBatch",
          },
          { actions: "incrementCompletedBatch" },
        ],
        IMPORT_FEED_ERROR: [
          {
            guard: "allFeedsCompleteAfterError",
            target: "idle",
            actions: "recordImportError",
          },
          { actions: "recordImportError" },
        ],
        IMPORT_LIMIT_WARNING: {
          actions: assign({
            importDeactivatedCount: ({ event }) => event.deactivatedCount,
            importMaxActiveFeeds: ({ event }) => event.maxActiveFeeds,
          }),
        },
        INITIAL_DATA_COMPLETE: { target: "idle" },
        RESET: { target: "idle" },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Singleton actor — created once at module scope
// ---------------------------------------------------------------------------

export const loadingActor = createActor(loadingMachine).start();

// ---------------------------------------------------------------------------
// Discriminated union consumed by UI components
// ---------------------------------------------------------------------------

export type LoadingMode =
  | { mode: "idle" }
  | { mode: "initialLoad" }
  | { mode: "backgroundRefresh"; progress: number }
  | { mode: "manualRefresh"; progress: number }
  | {
      mode: "importing";
      progress: number;
      completed: number;
      total: number;
      errors: number;
      failedImportUrls: Set<string>;
      importDeactivatedCount: number;
      importMaxActiveFeeds: number;
    };

function computeProgress(context: LoadingMachineContext): number {
  const { totalFeeds, completedFeeds, importErrors } = context;
  if (totalFeeds === 0) return 0;
  return ((completedFeeds + importErrors) / totalFeeds) * 100;
}

export function useLoadingMode(): LoadingMode {
  return useSelector(loadingActor, (snapshot): LoadingMode => {
    const { context } = snapshot;

    if (snapshot.matches("initialLoad")) {
      return { mode: "initialLoad" };
    }

    if (snapshot.matches("backgroundRefresh")) {
      return { mode: "backgroundRefresh", progress: computeProgress(context) };
    }

    if (snapshot.matches("manualRefresh")) {
      return { mode: "manualRefresh", progress: computeProgress(context) };
    }

    if (snapshot.matches("importing")) {
      return {
        mode: "importing",
        progress: computeProgress(context),
        completed: context.completedFeeds,
        total: context.totalFeeds,
        errors: context.importErrors,
        failedImportUrls: context.failedImportUrls,
        importDeactivatedCount: context.importDeactivatedCount,
        importMaxActiveFeeds: context.importMaxActiveFeeds,
      };
    }

    return { mode: "idle" };
  });
}

/**
 * Reads import-related context from the machine regardless of current state.
 * Useful for the post-import screen which needs these values after the machine
 * has transitioned back to idle. The context persists until the next IMPORT_START.
 */
export type ImportResults = {
  failedImportUrls: Set<string>;
  importDeactivatedCount: number;
  importMaxActiveFeeds: number;
};

export function useImportResults(): ImportResults {
  return useSelector(loadingActor, (snapshot): ImportResults => {
    const { context } = snapshot;
    return {
      failedImportUrls: context.failedImportUrls,
      importDeactivatedCount: context.importDeactivatedCount,
      importMaxActiveFeeds: context.importMaxActiveFeeds,
    };
  });
}

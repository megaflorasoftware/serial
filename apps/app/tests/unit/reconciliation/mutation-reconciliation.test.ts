import { eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { ORPCContext } from "~/server/orpc/base";
import {
  contentCategories,
  feedCategories,
  feedItems,
  feeds,
  user,
  viewCategories,
  viewFeeds,
  views,
} from "~/server/db/schema";

const testState = vi.hoisted(
  (): {
    database: unknown;
    fetchDueSources: ReturnType<typeof vi.fn>;
  } => ({
    database: undefined,
    fetchDueSources: vi.fn(),
  }),
);

vi.mock("~/server/db", () => ({
  get db() {
    return testState.database;
  },
}));
vi.mock("~/server/auth", () => ({ auth: {} }));
vi.mock("~/env", () => ({
  env: {
    BACKGROUND_REFRESH_ENABLED: false,
    DATABASE_URL: "file::memory:",
    KV_STORE: "none",
    PUBLIC_BASE_URL: "http://localhost:3000",
    TRUSTED_ORIGINS: [],
  },
}));
vi.mock("~/lib/orpc", async () => {
  const { createRouterClient: createClient } = await import("@orpc/server");
  const { orpcRouter: router } = await import("~/server/orpc/router");
  const real = createClient(router, {
    context: () =>
      ({
        headers: new Headers(),
        session: { id: "probe-session" },
        user: { id: USER_ID },
        db: testState.database,
      }) as ORPCContext,
  });
  return {
    orpc: new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => () => ({}) }) },
    ),
    orpcRouterClient: {
      feedItem: { setWatchedValue: real.feedItem.setWatchedValue },
      viewFeeds: { bulkRemoveFromView: real.viewFeeds.bulkRemoveFromView },
      bookmark: { getCaptures: real.bookmark.getCaptures },
      initial: {
        reconcileApplicationState: real.initial.reconcileApplicationState,
        requestFullTextForItems: real.initial.requestFullTextForItems,
        getNavigationSnapshot: real.initial.getNavigationSnapshot,
        fetchDueSources: testState.fetchDueSources,
      },
    },
  };
});

const USER_ID = "probe-user";
const VIEW_ID = 10;
const FEED_ID = 20;
const NOW = new Date("2026-09-11T12:00:00.000Z");
const UNREAD_COUNT = 30;
const ARCHIVED_COUNT = 30;

type TestDatabase = Awaited<
  ReturnType<typeof createBookmarkTestDatabase>
>["database"];
type Cleanup = Awaited<
  ReturnType<typeof createBookmarkTestDatabase>
>["cleanup"];

let database: TestDatabase;
let cleanup: Cleanup;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 10_000, label = "condition" } = {},
) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(20);
  }
}

beforeEach(async () => {
  vi.resetModules();
  ({ database, cleanup } = await createBookmarkTestDatabase());
  testState.database = database;
  testState.fetchDueSources.mockResolvedValue({
    status: "cooldown",
    nextRefreshAt: new Date(Date.now() + 60_000),
  });
  await database.insert(user).values({
    id: USER_ID,
    name: "Probe user",
    email: "probe@example.com",
    emailVerified: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(views).values({
    id: VIEW_ID,
    userId: USER_ID,
    name: "Reading",
    contentFilter: 3,
    placement: 1,
  });
  await database.insert(feeds).values({
    id: FEED_ID,
    userId: USER_ID,
    name: "Reading feed",
    platform: "website",
  });
  await database.insert(viewFeeds).values({ viewId: VIEW_ID, feedId: FEED_ID });
  const rows = [];
  for (let index = 0; index < UNREAD_COUNT; index++) {
    rows.push({
      id: `unread-${index}`,
      feedId: FEED_ID,
      contentId: `unread-${index}`,
      title: `Unread ${index}`,
      author: "Author",
      url: `https://example.com/unread-${index}`,
      postedAt: new Date(NOW.getTime() - index * 60_000),
      createdAt: NOW,
      updatedAt: NOW,
      isWatched: false,
    });
  }
  for (let index = 0; index < ARCHIVED_COUNT; index++) {
    rows.push({
      id: `archived-${index}`,
      feedId: FEED_ID,
      contentId: `archived-${index}`,
      title: `Archived ${index}`,
      author: "Author",
      url: `https://example.com/archived-${index}`,
      postedAt: new Date(NOW.getTime() - index * 60_000),
      createdAt: NOW,
      updatedAt: NOW,
      isWatched: true,
      isWatchedUpdatedAt: NOW,
    });
  }
  if (rows.length > 0) await database.insert(feedItems).values(rows);
  await import("~/lib/data/reconciliation");
}, 30_000);

afterEach(async () => {
  const { dataReconciliation } = await import("~/lib/data/reconciliation");
  dataReconciliation.stop();
  const { loadingActor } = await import("~/lib/data/loading-machine");
  loadingActor.stop();
  cleanup();
  vi.restoreAllMocks();
});

describe("mutation reconciliation", () => {
  it.each([
    { mutation: "archive", duringLoad: false },
    { mutation: "unarchive", duringLoad: false },
    { mutation: "archive", duringLoad: true },
    { mutation: "unarchive", duringLoad: true },
  ])(
    "repairs a full destination page after $mutation, during load: $duringLoad",
    async ({ mutation, duringLoad }) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { dataReconciliation } = await import("~/lib/data/reconciliation");
      const { publisher } = await import("~/server/api/publisher");
      const { feedItemsStore } = await import("~/lib/data/store");
      const { mixedContentStore, getMixedScopeKey } =
        await import("~/lib/data/mixed-content/store");
      const { orpcRouterClient } = await import("~/lib/orpc");
      const { applyOptimisticWatchedValue, resolveOptimisticWatchedValue } =
        await import("~/lib/data/feed-items/mutations");
      const originalReconcile =
        orpcRouterClient.initial.reconcileApplicationState;
      let resumeLoad = () => {};
      const loadGate = new Promise<void>((resolve) => {
        resumeLoad = resolve;
      });
      const reconcile = vi
        .spyOn(orpcRouterClient.initial, "reconcileApplicationState")
        .mockImplementation(async (...args) => {
          const stream = await originalReconcile(...args);
          return (async function* () {
            for await (const event of stream) {
              yield event;
              if (
                duringLoad &&
                event.chunk.type === "domain-complete" &&
                event.chunk.domain === "active-scope" &&
                event.chunk.target?.contentStatus.saveStatus === "inbox" &&
                event.chunk.target.contentStatus.archiveStatus === "archived"
              )
                await loadGate;
            }
          })();
        });
      const controller = new AbortController();
      const subscription = publisher.subscribe(`user:${USER_ID}`, {
        signal: controller.signal,
      });
      const forwarding = (async () => {
        try {
          for await (const payload of subscription)
            dataReconciliation.receivePublishedChunks([payload]);
        } catch {
          // Subscription abort during cleanup.
        }
      })();
      try {
        await sleep(0);
        dataReconciliation.start();
        dataReconciliation.sseConnectionChanged(true);
        await waitFor(() =>
          duringLoad
            ? mixedContentStore
                .getState()
                .scopes[
                  getMixedScopeKey(
                    { type: "view", viewId: VIEW_ID },
                    { saveStatus: "inbox", archiveStatus: "archived" },
                  )
                ]?.pages.some(
                  (page) =>
                    page.requestCursorKey === "root" &&
                    page.value.referenceKeys.length === 30,
                ) === true
            : dataReconciliation.getState().serverParityAppliedAt !== null &&
              dataReconciliation.getState().inFlight === null,
        );
        if (duringLoad)
          expect(dataReconciliation.getState().inFlight?.intent.type).toBe(
            "full",
          );
        const requestsBeforeMutation = reconcile.mock.calls.length;
        const itemId = mutation === "archive" ? "unread-0" : "archived-0";
        const isWatched = mutation === "archive";
        const context = applyOptimisticWatchedValue(itemId, isWatched);
        const serverValue = await orpcRouterClient.feedItem.setWatchedValue({
          id: itemId,
          feedId: FEED_ID,
          isWatched,
        });
        resolveOptimisticWatchedValue(context, serverValue);
        resumeLoad();
        await waitFor(
          () =>
            reconcile.mock.calls.length > requestsBeforeMutation &&
            dataReconciliation.getState().inFlight === null,
        );
        expect(errors.mock.calls).toEqual([]);
        expect(dataReconciliation.getState().retryPending).toBe(false);
        expect(dataReconciliation.getState().trustedUpToDate).toBe(true);
        const destination =
          mixedContentStore.getState().scopes[
            getMixedScopeKey(
              { type: "view", viewId: VIEW_ID },
              {
                saveStatus: "inbox",
                archiveStatus: isWatched ? "archived" : "unread",
              },
            )
          ];
        expect(
          destination?.pages.find((page) => page.requestCursorKey === "root")
            ?.value.referenceKeys,
        ).toHaveLength(30);
        expect(feedItemsStore.getState().feedItemsDict[itemId]?.isWatched).toBe(
          isWatched,
        );
      } finally {
        resumeLoad();
        controller.abort();
        await forwarding;
      }
    },
  );
});

describe("invalid request recovery through the transport", () => {
  it("keeps manual refresh pending until recovery restores the selected page", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dataReconciliation } = await import("~/lib/data/reconciliation");
    const { orpcRouterClient } = await import("~/lib/orpc");
    dataReconciliation.start();
    dataReconciliation.sseConnectionChanged(true);
    await waitFor(
      () =>
        dataReconciliation.getState().serverParityAppliedAt !== null &&
        dataReconciliation.getState().inFlight === null,
    );
    const original = orpcRouterClient.initial.reconcileApplicationState;
    const reconcile = vi
      .spyOn(orpcRouterClient.initial, "reconcileApplicationState")
      .mockImplementationOnce((input, options) =>
        original({ ...input, reconciliationId: "" }, options),
      );
    await dataReconciliation.requestManualFull();
    expect(reconcile).toHaveBeenCalledTimes(2);
    const originalInput = reconcile.mock.calls[0]![0];
    const recoveryInput = reconcile.mock.calls[1]![0];
    expect(originalInput).toMatchObject({
      type: "full",
      selection: { type: "selected", scope: { type: "view", viewId: VIEW_ID } },
    });
    if (originalInput.type !== "full")
      throw new Error("Expected full reconciliation");
    expect(recoveryInput).toMatchObject({
      type: "full",
      selection: {
        type: "selected",
        scope: { type: "view", viewId: VIEW_ID },
        contentStatus: originalInput.selection.contentStatus,
        pageManifest: { feedItems: [], bookmarks: [] },
      },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(dataReconciliation.getState()).toMatchObject({
      trustedUpToDate: true,
      retryPending: false,
      recoveryFailed: false,
    });
  });

  it("releases initial loading after terminal rejection and supports a new manual attempt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { dataReconciliation } = await import("~/lib/data/reconciliation");
    const { loadingActor } = await import("~/lib/data/loading-machine");
    const { orpcRouterClient } = await import("~/lib/orpc");
    const original = orpcRouterClient.initial.reconcileApplicationState;
    const reconcile = vi
      .spyOn(orpcRouterClient.initial, "reconcileApplicationState")
      .mockImplementation((input, options) =>
        original({ ...input, reconciliationId: "" }, options),
      );
    dataReconciliation.start();
    dataReconciliation.sseConnectionChanged(true);
    await waitFor(() => dataReconciliation.getState().recoveryFailed);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(dataReconciliation.getState()).toMatchObject({
      trustedUpToDate: false,
      serverParityAppliedAt: null,
      retryPending: false,
      inFlight: null,
    });
    expect(loadingActor.getSnapshot().matches("idle")).toBe(true);
    reconcile.mockRestore();
    await dataReconciliation.requestManualFull();
    expect(dataReconciliation.getState()).toMatchObject({
      trustedUpToDate: true,
      recoveryFailed: false,
    });
  });
});

describe("Feed removal from a loaded View", () => {
  it.each([
    { sourceKind: "rss" as const, retainedByTag: false, remainingTail: false },
    { sourceKind: "rss" as const, retainedByTag: false, remainingTail: true },
    {
      sourceKind: "atproto" as const,
      retainedByTag: false,
      remainingTail: false,
    },
    {
      sourceKind: "atproto" as const,
      retainedByTag: true,
      remainingTail: false,
    },
  ])(
    "reconciles later $sourceKind items after removal, retained by Tag: $retainedByTag, remaining tail: $remainingTail",
    async ({ sourceKind, retainedByTag, remainingTail }) => {
      await database.delete(feedItems).where(ne(feedItems.id, "unread-0"));
      await database
        .update(feedItems)
        .set({
          sourceKind,
          atprotoUri:
            sourceKind === "atproto"
              ? "at://did:plc:example/site.standard.document/older"
              : null,
        })
        .where(eq(feedItems.id, "unread-0"));
      await database.insert(views).values({
        id: 11,
        userId: USER_ID,
        name: "Other View",
        contentFilter: 3,
        placement: 2,
      });
      await database.insert(viewFeeds).values({ viewId: 11, feedId: FEED_ID });
      if (retainedByTag) {
        await database
          .insert(contentCategories)
          .values({ id: 1, userId: USER_ID, name: "Reading" });
        await database
          .insert(feedCategories)
          .values({ feedId: FEED_ID, categoryId: 1 });
        await database
          .insert(viewCategories)
          .values({ viewId: VIEW_ID, categoryId: 1 });
      }
      await database.insert(feeds).values({
        id: 21,
        userId: USER_ID,
        name: "Newer feed",
        platform: "website",
      });
      await database.insert(viewFeeds).values({ viewId: VIEW_ID, feedId: 21 });
      await database.insert(feedItems).values(
        Array.from({ length: 30 }, (_, index) => ({
          id: `newer-${index}`,
          feedId: 21,
          contentId: `newer-${index}`,
          title: `Newer ${index}`,
          author: "Author",
          url: `https://example.com/newer-${index}`,
          postedAt: new Date(NOW.getTime() + 60_000 + index * 1000),
          createdAt: NOW,
          updatedAt: NOW,
        })),
      );
      if (remainingTail) {
        await database.insert(feedItems).values({
          id: "remaining-tail",
          feedId: 21,
          contentId: "remaining-tail",
          title: "Still included",
          author: "Author",
          url: "https://example.com/remaining",
          postedAt: new Date(NOW.getTime() - 60_000),
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      const { dataReconciliation } = await import("~/lib/data/reconciliation");
      const { publisher } = await import("~/server/api/publisher");
      const { mixedContentStore, getMixedScopeKey } =
        await import("~/lib/data/mixed-content/store");
      const { orpcRouterClient } = await import("~/lib/orpc");
      const reconcile = vi.spyOn(
        orpcRouterClient.initial,
        "reconcileApplicationState",
      );
      const controller = new AbortController();
      const subscription = publisher.subscribe(`user:${USER_ID}`, {
        signal: controller.signal,
      });
      const forwarding = (async () => {
        try {
          for await (const payload of subscription)
            dataReconciliation.receivePublishedChunks([payload]);
        } catch {
          // Subscription abort during cleanup.
        }
      })();
      const scopeKey = getMixedScopeKey(
        { type: "view", viewId: VIEW_ID },
        { saveStatus: "inbox", archiveStatus: "unread" },
      );
      try {
        await sleep(0);
        dataReconciliation.start();
        dataReconciliation.sseConnectionChanged(true);
        await waitFor(() => dataReconciliation.getState().trustedUpToDate);
        expect(
          mixedContentStore.getState().scopes[scopeKey]?.references,
        ).toHaveLength(30);
        const { queryMixedContentPage } =
          await import("~/server/mixed-content/projection");
        const scope = { type: "view" as const, viewId: VIEW_ID };
        const contentStatus = {
          saveStatus: "inbox" as const,
          archiveStatus: "unread" as const,
        };
        const firstPage =
          mixedContentStore.getState().scopes[scopeKey]!.references;
        expect(firstPage.some(({ entityId }) => entityId === "unread-0")).toBe(
          false,
        );
        const cursor = mixedContentStore.getState().scopes[scopeKey]!.cursor;
        const nextPage = await queryMixedContentPage({
          database,
          userId: USER_ID,
          scope,
          contentStatus,
          cursor,
          limit: 30,
        });
        const { applyRequestedMixedContentPage } =
          await import("~/lib/data/subscriptionCoordinator");
        applyRequestedMixedContentPage({
          scope,
          contentStatus,
          page: nextPage,
          replacesScope: false,
        });
        expect(
          mixedContentStore.getState().scopes[scopeKey]?.references,
        ).toHaveLength(remainingTail ? 32 : 31);
        expect(
          mixedContentStore
            .getState()
            .scopes[scopeKey]?.references.some(
              ({ entityId }) => entityId === "unread-0",
            ),
        ).toBe(true);
        const requestsBeforeRemoval = reconcile.mock.calls.length;
        await orpcRouterClient.viewFeeds.bulkRemoveFromView({
          viewId: VIEW_ID,
          feedIds: [FEED_ID],
        });
        await waitFor(
          () =>
            reconcile.mock.calls.length > requestsBeforeRemoval &&
            dataReconciliation.getState().inFlight === null &&
            dataReconciliation.getState().trustedUpToDate,
        );
        const fresh = await queryMixedContentPage({
          database,
          userId: USER_ID,
          scope,
          contentStatus,
          limit: 500,
        });
        expect(fresh.references.slice(0, 30)).toEqual(firstPage);
        expect(fresh.references).toHaveLength(
          retainedByTag || remainingTail ? 31 : 30,
        );
        expect(
          fresh.references.some(({ entityId }) => entityId === "unread-0"),
        ).toBe(retainedByTag);
        const retained = mixedContentStore.getState().scopes[scopeKey]!;
        expect(retained.references).toEqual(
          retainedByTag ? fresh.references : fresh.references.slice(0, 30),
        );
        expect(retained.pages).toHaveLength(retainedByTag ? 2 : 1);
        expect(retained.hasMore).toBe(retainedByTag || remainingTail);
        const otherKey = getMixedScopeKey(
          { type: "view", viewId: 11 },
          contentStatus,
        );
        expect(
          mixedContentStore
            .getState()
            .scopes[otherKey]?.references.map(({ entityId }) => entityId),
        ).toEqual(["unread-0"]);
        const { feedItemsStore } = await import("~/lib/data/store");
        expect(
          feedItemsStore.getState().feedItemsDict["unread-0"],
        ).toBeDefined();
        expect(
          feedItemsStore.getState().scopeFeedItemIds[`mixed:${scopeKey}`],
        ).toHaveLength(retainedByTag ? 31 : 30);
        if (remainingTail) {
          const next = await queryMixedContentPage({
            database,
            userId: USER_ID,
            scope,
            contentStatus,
            cursor: retained.cursor,
            limit: 30,
          });
          applyRequestedMixedContentPage({
            scope,
            contentStatus,
            page: next,
            replacesScope: false,
          });
          expect(
            mixedContentStore.getState().scopes[scopeKey]?.references,
          ).toEqual(fresh.references);
        }
      } finally {
        controller.abort();
        await forwarding;
      }
    },
  );
});

import { expect, test } from "@playwright/test";
import { signIn } from "../fixtures/auth";
import {
  SELF_HOSTED_APP_PORT,
  SELF_HOSTED_TURSO_PORT,
} from "../fixtures/ports";
import {
  cleanupUser,
  seedArticleData,
  seedBookmarkProjectionData,
  seedMultipleArticleData,
  setFeedItemAsVideo,
  setFeedItemWatchLater,
} from "../fixtures/seed-db";
import type { Page } from "@playwright/test";

test.skip(
  process.env.SERIAL_CLIENT_PERFORMANCE_PRODUCTION !== "1",
  "The offline PWA check requires the production service worker.",
);

async function prepareControlledShell(page: Page) {
  const serviceWorkerResponse = await page.request.get("/sw.js");
  expect(serviceWorkerResponse.status()).toBe(200);
  expect(serviceWorkerResponse.headers()["content-type"]).toContain(
    "javascript",
  );

  await page.evaluate(() => navigator.serviceWorker.ready);
  if (
    !(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
  ) {
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
  }
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  await page.evaluate(() => {
    navigator.serviceWorker.controller?.postMessage({
      type: "WARM_NAVIGATION_CACHE",
    });
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open("navigation-cache");
        const response = await cache.match("/", { ignoreVary: true });
        return response
          ? { redirected: response.redirected, status: response.status }
          : null;
      }),
    )
    .toEqual({ redirected: false, status: 200 });
}

const CACHED_SHELL_MARKER = "data-serial-e2e-shell";

// Reads through `caches.match` so a deleted cache is not recreated empty.
async function getCachedRootShell(page: Page) {
  return page.evaluate(async () => {
    const response = await caches.match("/", {
      cacheName: "navigation-cache",
      ignoreVary: true,
    });
    return response ? await response.text() : null;
  });
}

// Marks the cached root document so a reload can prove it booted from the
// cache rather than from the server, and so the background revalidation is
// observable when the marker disappears. The attribute lives on <html>,
// which suppresses hydration warnings, so the marked shell hydrates as the
// real one does.
async function markCachedRootShell(page: Page) {
  await page.evaluate(async (marker) => {
    const cache = await caches.open("navigation-cache");
    const response = await cache.match("/", { ignoreVary: true });
    if (!response) throw new Error("The root shell is not cached");
    const html = (await response.text()).replace(
      "<html",
      `<html ${marker}="cached"`,
    );
    await cache.put(
      "/",
      new Response(html, { status: 200, headers: response.headers }),
    );
  }, CACHED_SHELL_MARKER);
}

async function getFeedBodyPersistence(page: Page, itemId: string) {
  return page.evaluate(async (id) => {
    const itemKey =
      `serial-application-store::normalized:v1::record:feedItemsDict:` +
      encodeURIComponent(id);
    const retainedBodyKey =
      `serial-application-store::normalized:v1::record:retainedFeedItemBodyIds:` +
      encodeURIComponent(id);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<{
        hasBody: boolean;
        isWatchLater: boolean | undefined;
        isWatched: boolean | undefined;
        retained: boolean;
      }>((resolve, reject) => {
        const transaction = database.transaction("keyval", "readonly");
        const store = transaction.objectStore("keyval");
        const itemRequest = store.get(itemKey);
        const retainedBodyRequest = store.get(retainedBodyKey);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => {
          const item = itemRequest.result as
            | {
                content?: string;
                isWatchLater?: boolean;
                isWatched?: boolean;
              }
            | undefined;
          resolve({
            hasBody: item?.content?.includes("Paragraph 1:") === true,
            isWatchLater: item?.isWatchLater,
            isWatched: item?.isWatched,
            retained: retainedBodyRequest.result === true,
          });
        };
      });
    } finally {
      database.close();
    }
  }, itemId);
}

async function hasBookmarkCapture(page: Page, bookmarkId: string) {
  return page.evaluate(async (id) => {
    const captureKey =
      `serial-bookmark-captures-store::normalized:v1::record:capturesDict:` +
      encodeURIComponent(id);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("keyval-store");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction("keyval", "readonly");
        const request = transaction.objectStore("keyval").get(captureKey);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () =>
          resolve(
            request.result?.contentHtml?.includes("Captured Bookmark body") ===
              true,
          );
      });
    } finally {
      database.close();
    }
  }, bookmarkId);
}

test("keeps only retained text interactive and read-only after an offline reload", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { feedItemIds, email, password } = await seedMultipleArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
    3,
  );
  const [retainedItemId, unavailableItemId, videoItemId] = feedItemIds;
  if (!retainedItemId || !unavailableItemId || !videoItemId) {
    throw new Error("Offline PWA fixture did not create three feed items");
  }
  await setFeedItemAsVideo(SELF_HOSTED_TURSO_PORT, videoItemId, "M7lc1UVf-VE");

  try {
    await signIn({ page, email, password });
    const retainedCard = page.locator(
      `article[data-item-id="${retainedItemId}"]`,
    );
    const unavailableCard = page.locator(
      `article[data-item-id="${unavailableItemId}"]`,
    );
    const videoCard = page.locator(`article[data-item-id="${videoItemId}"]`);
    await expect(retainedCard).toBeVisible({ timeout: 15_000 });
    await expect(unavailableCard).toBeVisible();
    await expect(videoCard).toBeVisible();

    await prepareControlledShell(page);

    // Save without opening the reader. The mutation must retain its body.
    await retainedCard.getByRole("link").hover();
    await page.keyboard.press("s");
    await expect(retainedCard).toHaveCount(0);
    await expect
      .poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        return getFeedBodyPersistence(page, retainedItemId);
      })
      .toEqual({
        hasBody: true,
        isWatchLater: true,
        isWatched: false,
        retained: true,
      });

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible({ timeout: 15_000 });

    const offlineUnavailableCard = page.locator(
      `article[data-item-id="${unavailableItemId}"]`,
    );
    const offlineVideoCard = page.locator(
      `article[data-item-id="${videoItemId}"]`,
    );
    for (const candidateCard of [offlineUnavailableCard, offlineVideoCard]) {
      await expect(candidateCard).toHaveClass(/opacity-50/);
      await expect(candidateCard.getByRole("link")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }

    // The selected-card shortcut cannot create an optimistic offline write.
    await offlineUnavailableCard.getByRole("link").hover();
    await page.keyboard.press("s");
    await expect
      .poll(() => getFeedBodyPersistence(page, unavailableItemId))
      .toMatchObject({ isWatchLater: false, retained: false });
    const offlineUrl = page.url();
    await offlineUnavailableCard.getByRole("link").click({ force: true });
    await expect(page).toHaveURL(offlineUrl);

    // Content-status filters stay local and enabled while disconnected.
    await page.getByRole("tab", { name: "Saved" }).click();
    const offlineRetainedCard = page.locator(
      `article[data-item-id="${retainedItemId}"]`,
    );
    await expect(offlineRetainedCard.getByRole("link")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await offlineRetainedCard.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/read/${retainedItemId}$`));
    await expect(page.getByText("Paragraph 1:")).toBeVisible();
    const archiveButton = page.getByRole("button", { name: "Archive" });
    await expect(archiveButton).toBeDisabled();
    await page.keyboard.press("e");
    await expect
      .poll(() => getFeedBodyPersistence(page, retainedItemId))
      .toMatchObject({ hasBody: true, isWatched: false, retained: true });

    await context.setOffline(false);
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeHidden({ timeout: 15_000 });
    await expect(archiveButton).toBeEnabled();
    await archiveButton.click();
    await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect
      .poll(() => getFeedBodyPersistence(page, retainedItemId))
      .toMatchObject({ hasBody: false, isWatched: true, retained: false });
  } finally {
    await context.setOffline(false);
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

test("keeps an opened Unread text item readable after an offline reload", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { feedItemId, email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );

  try {
    await signIn({ page, email, password });
    const card = page.locator(`article[data-item-id="${feedItemId}"]`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await prepareControlledShell(page);

    // Ordinary reading loads the body; that alone retains it, without the
    // item ever being saved.
    const listUrl = page.url();
    await card.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/read/${feedItemId}$`));
    await expect(page.getByText("Paragraph 1:")).toBeVisible();
    await page.goBack();
    // The popstate must settle before persistence is polled.
    await expect(page).toHaveURL(listUrl);
    await expect(card).toBeVisible();
    await expect
      .poll(async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        return getFeedBodyPersistence(page, feedItemId);
      })
      .toEqual({
        hasBody: true,
        isWatchLater: false,
        isWatched: false,
        retained: true,
      });

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible({ timeout: 15_000 });

    const offlineCard = page.locator(`article[data-item-id="${feedItemId}"]`);
    await expect(offlineCard.getByRole("link")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await offlineCard.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/read/${feedItemId}$`));
    await expect(page.getByText("Paragraph 1:")).toBeVisible();
  } finally {
    await context.setOffline(false);
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

test("reloads a retained Bookmark capture through the production service worker", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { feedItemId, email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );
  const { bookmarkId } = await seedBookmarkProjectionData(
    SELF_HOSTED_TURSO_PORT,
    email,
    feedItemId,
  );

  try {
    await signIn({ page, email, password });
    await page.getByRole("tab", { name: /Saved/ }).click();
    const bookmarkCard = page.locator(
      `article[data-item-id="${bookmarkId}"][data-entity-kind="bookmark"]`,
    );
    await expect(bookmarkCard).toBeVisible({ timeout: 15_000 });
    await bookmarkCard.getByRole("link").click();
    await expect(page.getByText("Captured Bookmark body")).toBeVisible();
    await expect.poll(() => hasBookmarkCapture(page, bookmarkId)).toBe(true);
    await prepareControlledShell(page);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(new RegExp(`/read/${bookmarkId}$`));
    await expect(page.getByText("Captured Bookmark body")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive" })).toBeDisabled();
  } finally {
    await context.setOffline(false);
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

test("opens pre-saved content offline after passive hydration alone", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { feedItemId, email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );
  // Saved before the session starts, so only page-scoped hydration after the
  // view-matrix cells apply can retain the body and fetch the capture.
  await setFeedItemWatchLater(SELF_HOSTED_TURSO_PORT, feedItemId, true);
  const { bookmarkId } = await seedBookmarkProjectionData(
    SELF_HOSTED_TURSO_PORT,
    email,
    feedItemId,
  );

  try {
    await signIn({ page, email, password });
    await prepareControlledShell(page);

    // No interaction with either item: poll persistence until deferred
    // hydration lands, flushing the throttled IDB writer each attempt.
    await expect
      .poll(
        async () => {
          await page.evaluate(() =>
            window.dispatchEvent(new Event("pagehide")),
          );
          return getFeedBodyPersistence(page, feedItemId);
        },
        { timeout: 20_000 },
      )
      .toEqual({
        hasBody: true,
        isWatchLater: true,
        isWatched: false,
        retained: true,
      });
    await expect
      .poll(
        async () => {
          await page.evaluate(() =>
            window.dispatchEvent(new Event("pagehide")),
          );
          return hasBookmarkCapture(page, bookmarkId);
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Saved" }).click();
    const listUrl = page.url();
    const savedFeedCard = page.locator(`article[data-item-id="${feedItemId}"]`);
    await expect(savedFeedCard.getByRole("link")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await savedFeedCard.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/read/${feedItemId}$`));
    await expect(page.getByText("Paragraph 1:")).toBeVisible();

    await page.goBack();
    // The popstate must settle before the tab click, or the click races it.
    await expect(page).toHaveURL(listUrl);
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByRole("tab", { name: "Saved" }).click();
    const savedBookmarkCard = page.locator(
      `article[data-item-id="${bookmarkId}"][data-entity-kind="bookmark"]`,
    );
    await expect(savedBookmarkCard.getByRole("link")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await savedBookmarkCard.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/read/${bookmarkId}$`));
    await expect(page.getByText("Captured Bookmark body")).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await context.setOffline(false);
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

// The production build under e2e fault controls leaves the reader route
// chunk out of the precache manifest, reproducing a deploy where the
// controlling service worker predates the chunk. Only the runtime script
// cache can then serve it offline.
const READER_CHUNK_PATTERN = "/assets/_app.read";

async function getReaderChunkCacheNames(page: Page) {
  return page.evaluate(async (pattern) => {
    const names: string[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      if (keys.some((request) => request.url.includes(pattern))) {
        names.push(cacheName);
      }
    }
    return names.sort();
  }, READER_CHUNK_PATTERN);
}

// The preloader runs once per page lifetime, and on the very first load it
// can fire before the freshly installed worker claims the page, so that
// fetch never reaches the runtime cache. Every later visit boots under
// worker control; start the assertions from such a visit.
async function reloadUnderServiceWorkerControl(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
}

// Deferred hydration retains the pre-saved body; flushing the throttled IDB
// writer each attempt makes the offline reload start from persisted state.
async function waitForRetainedFeedBody(page: Page, feedItemId: string) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
        return getFeedBodyPersistence(page, feedItemId);
      },
      { timeout: 20_000 },
    )
    .toMatchObject({ hasBody: true, retained: true });
}

async function evictReaderChunk(page: Page) {
  await page.evaluate(async (pattern) => {
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        if (request.url.includes(pattern)) await cache.delete(request);
      }
    }
  }, READER_CHUNK_PATTERN);
  // The browser HTTP cache would otherwise mask a missing service-worker
  // cache entry while offline.
  const session = await page.context().newCDPSession(page);
  await session.send("Network.clearBrowserCache");
  await session.detach();
  expect(await getReaderChunkCacheNames(page)).toEqual([]);
}

test("fetches the reader chunk for saved content before it is opened", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { feedItemId, email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );
  await setFeedItemWatchLater(SELF_HOSTED_TURSO_PORT, feedItemId, true);

  try {
    await signIn({ page, email, password });
    await prepareControlledShell(page);
    await reloadUnderServiceWorkerControl(page);
    await waitForRetainedFeedBody(page, feedItemId);

    // Retained content plus a live connection is what triggers the preload;
    // nothing hovers or opens the item.
    await expect
      .poll(() => getReaderChunkCacheNames(page), { timeout: 20_000 })
      .toEqual(["static-assets"]);

    const session = await context.newCDPSession(page);
    await session.send("Network.clearBrowserCache");
    await session.detach();

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Saved" }).click();
    const savedCard = page.locator(`article[data-item-id="${feedItemId}"]`);
    await expect(savedCard.getByRole("link")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await savedCard.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/read/${feedItemId}$`));
    await expect(page.getByText("Paragraph 1:")).toBeVisible();
  } finally {
    await context.setOffline(false);
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

test("keeps the app frame when the reader chunk cannot load offline", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { feedItemId, email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );
  await setFeedItemWatchLater(SELF_HOSTED_TURSO_PORT, feedItemId, true);

  try {
    await signIn({ page, email, password });
    await prepareControlledShell(page);
    await reloadUnderServiceWorkerControl(page);
    await waitForRetainedFeedBody(page, feedItemId);
    await expect
      .poll(() => getReaderChunkCacheNames(page), { timeout: 20_000 })
      .toEqual(["static-assets"]);
    await evictReaderChunk(page);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Saved" }).click();
    const savedCard = page.locator(`article[data-item-id="${feedItemId}"]`);
    await expect(savedCard.getByRole("link")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await savedCard.getByRole("link").click();

    // The router reloads once on a failed import, then surfaces the error;
    // the layout boundary renders it inside the frame.
    await expect(
      page.getByText("This content isn't available offline."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/read/${feedItemId}$`));
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);

    await page.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByText("This content isn't available offline."),
    ).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

test("opens from the cached shell and refreshes it in the background", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { feedItemId, email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );

  try {
    await signIn({ page, email, password });
    await prepareControlledShell(page);
    await markCachedRootShell(page);

    await page.reload({ waitUntil: "domcontentloaded" });

    // The document came from the navigation cache, not the server.
    await expect(
      page.locator(`html[${CACHED_SHELL_MARKER}="cached"]`),
    ).toHaveCount(1);
    // The stale shell still boots the live application.
    await expect(
      page.locator(`article[data-item-id="${feedItemId}"]`),
    ).toBeVisible({ timeout: 15_000 });
    // Background revalidation replaced the marked entry with the server's.
    await expect
      .poll(
        async () => {
          const shell = await getCachedRootShell(page);
          return shell === null
            ? "missing"
            : shell.includes(CACHED_SHELL_MARKER);
        },
        { timeout: 15_000 },
      )
      .toBe(false);
  } finally {
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

test("returns to sign-in when the session behind the cached shell has ended", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  const { email, password } = await seedArticleData(
    SELF_HOSTED_TURSO_PORT,
    SELF_HOSTED_APP_PORT,
  );

  try {
    await signIn({ page, email, password });
    await prepareControlledShell(page);

    await context.clearCookies();
    // The worker navigates this page away once revalidation lands, which
    // can interrupt a wait for the stale document's DOMContentLoaded.
    await page.reload({ waitUntil: "commit" });

    // The stale shell is served first; revalidation sees the server redirect
    // and reloads the page through the network.
    await expect(page).toHaveURL(/\/auth\/sign-in/, { timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Sign in with Email" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("Offline, some features may be disabled"),
    ).toHaveCount(0);
    // The revalidation dropped the stale application shell; the sign-in
    // document that replaced it is cached by the network-first auth route.
    expect(await getCachedRootShell(page)).toBeNull();
  } finally {
    await cleanupUser(SELF_HOSTED_TURSO_PORT, email);
  }
});

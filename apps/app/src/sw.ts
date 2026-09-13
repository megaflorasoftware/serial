/// <reference lib="webworker" />
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
} from "workbox-precaching";
import {
  NavigationRoute,
  registerRoute,
  setCatchHandler,
} from "workbox-routing";
import {
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
  Strategy,
} from "workbox-strategies";
import type { StrategyHandler } from "workbox-strategies";
import {
  AUTH_NAVIGATION_PATTERN,
  classifyNavigationRevalidation,
  deleteNavigationCache,
  getCacheableNavigationResponse,
  NAVIGATION_CACHE_INVALIDATED_MESSAGE,
  NAVIGATION_CACHE_NAME,
  normalizeNavigationResponse,
} from "~/lib/pwa/navigation-cache";

declare let self: ServiceWorkerGlobalScope;

function isApplicationClient(client: Client) {
  return !AUTH_NAVIGATION_PATTERN.test(new URL(client.url).pathname);
}

async function notifyClientsOfInvalidatedShell(resultingClientId: string) {
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  // The page that just booted from the stale shell may not be listed yet
  // if its navigation has not committed; address it directly as well.
  const resultingClient = await self.clients.get(resultingClientId);
  const recipients = new Map<string, Client>(
    clients.map((client) => [client.id, client]),
  );
  if (resultingClient) recipients.set(resultingClient.id, resultingClient);
  await Promise.all(
    [...recipients.values()]
      // Authentication pages are exactly where the redirect leads; reloading
      // one under the user would discard a form in progress.
      .filter(isApplicationClient)
      .map(reloadClientThroughNetwork),
  );
}

// The page that booted from the stale shell may not have hydrated far enough
// to listen for worker messages yet, so navigate it directly; a message is
// the fallback for a client this worker does not control.
async function reloadClientThroughNetwork(client: Client) {
  if (client instanceof WindowClient) {
    try {
      await client.navigate(client.url);
      return;
    } catch {
      // Not controlled by this worker; fall through to the message.
    }
  }
  client.postMessage({ type: NAVIGATION_CACHE_INVALIDATED_MESSAGE });
}

// The server sent the document elsewhere (sign-in, demo provisioning,
// maintenance), so every cached shell belongs to a session that has ended.
async function invalidateNavigationCache(resultingClientId?: string) {
  await deleteNavigationCache(self.caches);
  if (resultingClientId !== undefined) {
    await notifyClientsOfInvalidatedShell(resultingClientId);
  }
}

async function fetchRootShell() {
  const request = new Request("/", {
    credentials: "include",
    headers: { Accept: "text/html" },
    redirect: "follow",
  });
  const response = await fetch(request);
  if (classifyNavigationRevalidation(request.url, response) === "redirected") {
    await invalidateNavigationCache();
    return null;
  }
  return getCacheableNavigationResponse(request.url, response);
}

async function warmNavigationCache() {
  const shell = await fetchRootShell();
  if (!shell) return;
  const cache = await caches.open(NAVIGATION_CACHE_NAME);
  await cache.put("/", shell);
}

// A new build's documents reference new content-hashed chunks, so the
// previous build's cached documents must go. Fetch the fresh root first:
// when the worker activates offline, the old shell stays in place rather
// than leaving nothing to serve.
async function replaceNavigationCache() {
  const shell = await fetchRootShell();
  if (!shell) return;
  await deleteNavigationCache(self.caches);
  const cache = await caches.open(NAVIGATION_CACHE_NAME);
  await cache.put("/", shell);
}

/**
 * Serve the cached document immediately and refresh it in the background.
 *
 * A full load of the installed app is a navigation request. Waiting for the
 * server-rendered document (session lookup, user config, render) made every
 * online launch slower than an offline one, where the fetch fails at once
 * and the cached shell is served. Scripts and styles are already cache-first,
 * so the document is the only piece that has to be served stale.
 *
 * A navigation request carries manual redirect handling, so a background
 * revalidation the server redirects (sign-in, demo provisioning,
 * maintenance) surfaces as an opaque redirect: the session behind the
 * cached shell has ended, the cache is dropped, and the page that booted
 * from the stale shell reloads so the server redirect takes effect. A
 * failed or non-OK revalidation keeps the stale shell.
 */
class ShellFirstNavigationStrategy extends Strategy {
  protected async _handle(request: Request, handler: StrategyHandler) {
    const cachedResponse = await handler.cacheMatch(request);
    const resultingClientId =
      handler.event instanceof FetchEvent
        ? handler.event.resultingClientId
        : undefined;
    const revalidation = handler.fetch(request).then((response) =>
      this.revalidate(request, response, handler, {
        servedStale: cachedResponse !== undefined,
        resultingClientId,
      }),
    );
    if (cachedResponse) {
      void handler.waitUntil(
        revalidation.catch(() => {
          // Offline or unreachable: the stale shell stays in place.
        }),
      );
      return cachedResponse;
    }
    return revalidation;
  }

  private async revalidate(
    request: Request,
    response: Response,
    handler: StrategyHandler,
    {
      servedStale,
      resultingClientId,
    }: {
      servedStale: boolean;
      resultingClientId: string | undefined;
    },
  ) {
    switch (classifyNavigationRevalidation(request.url, response)) {
      case "cache":
        await handler.cachePut(
          request,
          normalizeNavigationResponse(response.clone()),
        );
        break;
      case "redirected":
        await invalidateNavigationCache(
          servedStale ? resultingClientId : undefined,
        );
        break;
      case "keep-stale":
        break;
    }
    return response;
  }
}

// Take control of all open clients as soon as the SW activates, and warm
// the navigation cache so offline works even before the user's first
// SW-controlled navigation. Without clients.claim(), the first page load
// that triggers installation isn't controlled until the user reloads —
// meaning offline support doesn't kick in until the second visit. On iOS
// Safari this is especially important because the browser aggressively
// kills idle service workers.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // TanStack Start is fully SSR — there are no static HTML files in the
      // build output, so precacheAndRoute never caches any document. Replace
      // the navigation cache with this build's root page so there's always
      // *something* to serve when the user opens the app offline.
      replaceNavigationCache().catch(() => {
        // Non-critical. The next real navigation will populate the cache.
      }),
    ]),
  );
});

// Clean up old caches from previous versions
cleanupOutdatedCaches();

// Precache static assets injected by workbox-build
// self.__WB_MANIFEST is injected by workbox-build at build time
precacheAndRoute(self.__WB_MANIFEST);

// Authentication documents redirect on session state and are loaded rarely,
// so they are never served stale: NetworkFirst with a 3s timeout keeps them
// fresh with an offline fallback.
registerRoute(
  new NavigationRoute(
    new NetworkFirst({
      cacheName: NAVIGATION_CACHE_NAME,
      networkTimeoutSeconds: 3,
      plugins: [
        {
          cacheWillUpdate: ({ request, response }) =>
            Promise.resolve(
              getCacheableNavigationResponse(request.url, response),
            ),
        },
      ],
    }),
    { allowlist: [AUTH_NAVIGATION_PATTERN] },
  ),
);

// Every other application document is served from the cache first. API
// navigations (demo provisioning) are redirects, never documents to keep.
registerRoute(
  new NavigationRoute(
    new ShellFirstNavigationStrategy({
      cacheName: NAVIGATION_CACHE_NAME,
      matchOptions: { ignoreVary: true },
    }),
    { denylist: [AUTH_NAVIGATION_PATTERN, /^\/api\//] },
  ),
);

// Offline navigation fallback.
// TanStack Start is fully SSR — there are no static HTML files in the build
// output. Navigation responses are only cached as users visit pages. If the
// user navigates to an uncached URL while offline (or the cache was evicted),
// fall back to the cached root page so the app shell loads instead of showing
// a browser error. The client-side router can then resolve the correct route.
setCatchHandler(async ({ request }) => {
  if (request.destination === "document") {
    // Layer 1: try the runtime navigation cache (SSR HTML with hydration data)
    const cache = await caches.open(NAVIGATION_CACHE_NAME);
    // ignoreVary prevents mismatches between the warm-up request's headers
    // (Accept: */*) and the real navigation request's headers (Accept:
    // text/html,...) when the server sends a Vary header.
    const cachedRoot = await cache.match("/", { ignoreVary: true });
    if (cachedRoot) {
      return cachedRoot;
    }

    // Layer 2: static offline page from the precache. The precache is
    // populated during SW install and is more durable than runtime caches —
    // iOS Safari can evict runtime caches after ~7 days of inactivity, but
    // the precache survives as long as the SW registration exists.
    const offlinePage = await matchPrecache("/offline.html");
    if (offlinePage) {
      return offlinePage;
    }
  }

  return Response.error();
});

// Static assets (JS/CSS) - CacheFirst (Vite hashes them, so safe to cache long-term)
registerRoute(
  ({ request }) =>
    request.destination === "script" || request.destination === "style",
  new CacheFirst({
    cacheName: "static-assets",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        maxEntries: 100,
      }),
      {
        // After a deploy the page can boot from new HTML while this (older)
        // worker still controls it: the new code-split chunks are missing
        // from this worker's manifest and from the runtime cache, but the
        // waiting worker has already installed them into the shared
        // precache. When the network is unavailable, look the request up in
        // every cache before failing the import. Precache keys carry a
        // `__WB_REVISION__` query parameter; content-hashed asset names make
        // ignoring the search safe, so the fallback stays scoped to them.
        handlerDidError: ({ request }) =>
          new URL(request.url).pathname.startsWith("/assets/")
            ? caches.match(request, { ignoreSearch: true })
            : Promise.resolve(undefined),
      },
    ],
  }),
);

// Fonts - CacheFirst with long expiration
registerRoute(
  ({ request }) => request.destination === "font",
  new CacheFirst({
    cacheName: "font-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
        maxEntries: 30,
      }),
    ],
  }),
);

// Images - StaleWhileRevalidate
registerRoute(
  ({ request }) => request.destination === "image",
  new StaleWhileRevalidate({
    cacheName: "image-cache",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
        maxEntries: 100,
      }),
    ],
  }),
);

// YouTube thumbnails - StaleWhileRevalidate for offline feed viewing
registerRoute(
  ({ url }) =>
    url.hostname === "i.ytimg.com" || url.hostname === "img.youtube.com",
  new StaleWhileRevalidate({
    cacheName: "youtube-thumbnails",
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
        maxEntries: 200,
      }),
    ],
  }),
);

// API calls (ORPC) - NetworkFirst with 5s timeout
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/rpc"),
  new NetworkFirst({
    cacheName: "api-cache",
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 60 * 60, // 1 hour
        maxEntries: 50,
      }),
    ],
  }),
);

// Listen for messages from the client
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }

  // Re-warm the navigation cache on every app launch. iOS Safari evicts all
  // cached data after ~7 days of inactivity, so the activate-time warm-up
  // alone isn't enough — each online visit needs to reset that clock.
  if (event.data && event.data.type === "WARM_NAVIGATION_CACHE") {
    event.waitUntil(
      warmNavigationCache().catch(() => {
        // Non-critical. The NetworkFirst handler will cache a later navigation.
      }),
    );
  }
});

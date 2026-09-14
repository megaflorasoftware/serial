export const NAVIGATION_CACHE_NAME = "navigation-cache";

/**
 * Posted by the service worker to controlled application pages when a
 * background revalidation found that the shell they booted from is no
 * longer valid, so the page must reload through the network.
 */
export const NAVIGATION_CACHE_INVALIDATED_MESSAGE =
  "NAVIGATION_CACHE_INVALIDATED";

/**
 * Authentication documents redirect on session state and are loaded
 * rarely, so they are never served stale. Tested against a pathname or a
 * pathname plus search string.
 */
export const AUTH_NAVIGATION_PATTERN = /^\/auth(?:[/?]|$)/;

export function normalizeNavigationResponse(response: Response) {
  if (!response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function responsePathname(response: Response) {
  // Synthetic responses (tests, constructed fallbacks) have an empty URL and
  // carry no redirect risk.
  if (!response.url) return null;
  return new URL(response.url).pathname;
}

/**
 * The outcome of fetching an application document for the navigation cache.
 *
 * - `cache`: a valid shell for the requested path; store it.
 * - `keep-stale`: the server failed without redirecting; a stale shell is
 *   better than an error page.
 * - `redirected`: the server sent the request elsewhere (sign-in, demo
 *   provisioning, maintenance), so no cached shell for this session is
 *   valid any more.
 */
export type NavigationRevalidation = "cache" | "keep-stale" | "redirected";

export function classifyNavigationRevalidation(
  requestUrl: string,
  response: Response,
): NavigationRevalidation {
  // A navigation request is fetched with manual redirect handling, so the
  // worker sees an opaque redirect with no URL instead of the destination.
  if (response.type === "opaqueredirect") return "redirected";
  const finalPathname = responsePathname(response);
  if (
    finalPathname !== null &&
    finalPathname !== new URL(requestUrl).pathname
  ) {
    return "redirected";
  }
  if (!response.ok) return "keep-stale";
  return "cache";
}

/**
 * A navigation response may only be cached under the path that produced it.
 * An unauthenticated fetch of `/` resolves at `/auth/sign-in`; caching that
 * HTML under the requested path would serve the sign-in shell as the offline
 * fallback after the user signs back in.
 */
export function isCacheableNavigationResponse(
  requestUrl: string,
  response: Response,
) {
  return classifyNavigationRevalidation(requestUrl, response) === "cache";
}

export function getCacheableNavigationResponse(
  requestUrl: string,
  response: Response,
) {
  if (!isCacheableNavigationResponse(requestUrl, response)) return null;
  return normalizeNavigationResponse(response);
}

/**
 * Drop every cached document. Used when the session that produced them
 * ended (sign-out, server redirect) and when a new build activates, since
 * the cached HTML references the previous build's content-hashed chunks.
 */
export function deleteNavigationCache(cacheStorage: CacheStorage | undefined) {
  if (!cacheStorage) return Promise.resolve(false);
  return cacheStorage.delete(NAVIGATION_CACHE_NAME);
}

/**
 * The URL a window is sent back through the network after its shell was
 * invalidated. Navigating a window to its own URL with the fragment intact
 * is a fragment navigation that never leaves the document, so the fragment
 * is dropped.
 */
export function getShellReloadUrl(clientUrl: string) {
  const url = new URL(clientUrl);
  url.hash = "";
  return url.href;
}

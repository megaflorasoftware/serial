import { HTTPClient } from "@polar-sh/sdk/lib/http.js";

/**
 * Polar date-based API version pinned for every outbound request.
 * Polar promotes a new version each quarter; unpinned requests silently follow
 * the current one. Bump this alongside an SDK upgrade that targets the new spec.
 */
export const POLAR_API_VERSION = "2026-04";

export const POLAR_VERSION_HEADER = "Polar-Version";

function pinPolarVersion(request: Request): Request {
  request.headers.set(POLAR_VERSION_HEADER, POLAR_API_VERSION);
  return request;
}

/** HTTP client for the Polar SDK that pins every request to POLAR_API_VERSION. */
export function createPolarHttpClient(
  options?: ConstructorParameters<typeof HTTPClient>[0],
): HTTPClient {
  return new HTTPClient(options).addHook("beforeRequest", pinPolarVersion);
}

/**
 * Client-side session detection for the app call-to-action.
 *
 * The app's Better Auth session cookie is scoped to the shared cookie domain
 * but is httpOnly, so page scripts cannot read it. Instead the browser sends
 * it on a credentialed request to the app's session endpoint, which already
 * returns credentialed CORS headers for https origins on that domain. Any
 * failure (CORS refusal, network error, null session) leaves the static
 * "Get Started" copy in place.
 */

export const APP_LINK_ATTRIBUTE = "data-app-link";
export const SESSION_ENDPOINT_PATH = "/api/auth/get-session";
export const SIGNED_OUT_LABEL = "Get Started";
export const SIGNED_IN_LABEL = "Open Serial";

export function sessionEndpointUrl(appUrl: string): string {
  return new URL(SESSION_ENDPOINT_PATH, appUrl).toString();
}

/**
 * Whether a session endpoint response represents a signed-in visitor: HTTP
 * 200 with a non-null session object in the body.
 */
export async function isSignedIn(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try {
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "session" in body &&
      typeof body.session === "object" &&
      body.session !== null
    );
  } catch {
    return false;
  }
}

/**
 * Whether the visitor has an app session. Never throws; every failure mode
 * reads as signed out.
 */
export async function checkSession(
  appUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(sessionEndpointUrl(appUrl), {
      credentials: "include",
    });
    return await isSignedIn(response);
  } catch {
    return false;
  }
}

export function applySignedInLabel(elements: Iterable<Element>): void {
  for (const element of elements) {
    element.textContent = SIGNED_IN_LABEL;
  }
}

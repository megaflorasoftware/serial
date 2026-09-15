import { OAuthCallbackError } from "@atproto/oauth-client-node";

/**
 * Whether a failed callback is the user's refusal at the authorization
 * server. Two things must hold: the SDK raised its own callback error, and
 * that error carries the app state, which the SDK attaches only after it
 * has matched the request to a stored authorization attempt and read the
 * `error` param. A replayed or forged request carrying `error=access_denied`
 * fails state lookup first, arrives without app state, and stays an error.
 * Every Serial flow stores app state, so a genuine denial always has it.
 */
export function isConsentDenied(err: unknown): boolean {
  return (
    err instanceof OAuthCallbackError &&
    err.state !== undefined &&
    err.params.get("error") === "access_denied"
  );
}

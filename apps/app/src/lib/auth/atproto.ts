/**
 * Client-safe AT Protocol auth constants shared between the server plugin
 * and the UI. No env access — the server-side machinery lives under
 * server/auth/atproto.
 */

/**
 * Reserved domain of the deterministic internal placeholder email a
 * DID-only user carries (see placeholderEmailForDid in
 * server/auth/atproto/config). Never surfaced in UI and never deliverable.
 */
export const ATPROTO_PLACEHOLDER_EMAIL_DOMAIN = "atproto.invalid";

/**
 * Whether an email is the internal DID placeholder rather than a real,
 * user-provided address. Email-dependent surfaces (password setup, the
 * settings email field) treat a placeholder as "no email yet".
 */
export function isAtprotoPlaceholderEmail(email: string): boolean {
  return email.endsWith(`@${ATPROTO_PLACEHOLDER_EMAIL_DOMAIN}`);
}

/**
 * The email a surface may show for a user, or undefined when the user has
 * none. A DID-only user's placeholder counts as no email; every surface
 * that renders an address (account menu, profile settings, admin user
 * views) goes through this so the placeholder is never displayed.
 */
export function getDisplayableEmail(
  email: string | null | undefined,
): string | undefined {
  return email && !isAtprotoPlaceholderEmail(email) ? email : undefined;
}

/**
 * Query param the link callback redirects back into the app with, carrying
 * one of the result codes below. The app shell toasts it and reopens the
 * connections dialog, mirroring the Polar portal-return convention.
 */
export const ATPROTO_LINK_RESULT_PARAM = "atproto_link";

export type AtprotoLinkResult = "success" | "conflict" | "exists" | "error";

/**
 * Query param the consent-upgrade callback redirects back into the app
 * with. Kept separate from the link result so a consent return can trigger
 * a subscription sync while a link return never does.
 */
export const ATPROTO_CONSENT_RESULT_PARAM = "atproto_consent";

export type AtprotoConsentResult = "success" | "denied" | "state" | "error";

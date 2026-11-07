import { createHmac } from "node:crypto";
import { REPO_ACTIONS, RepoPermission } from "@atproto/oauth-scopes";
import { STANDARD_SITE_COLLECTIONS } from "@serial/standard-site";
import {
  buildAtprotoLoopbackClientMetadata,
  JoseKey,
} from "@atproto/oauth-client-node";
import { parseEncryptionKey } from "./crypto";
import { getAtprotoClientMode } from "./mode";
import type { OAuthClientMetadataInput } from "@atproto/oauth-client-node";
import { ATPROTO_PLACEHOLDER_EMAIL_DOMAIN } from "~/lib/auth/atproto";
import { env } from "~/env";

/**
 * Configuration surface for the AT Protocol OAuth client. Serial runs as a
 * confidential client only: ATPROTO_CLIENT_PRIVATE_KEYS holds a JSON array
 * of ES256 private JWKs (the keyset), and ATPROTO_STORE_ENCRYPTION_KEY the
 * base64 AES-256 key for the encrypted stores. Env validation guarantees
 * the pair is present together; the parsers here fail startup with a clear
 * message when either value is malformed.
 *
 * Rotation: prepend a fresh key to the keyset — the first key signs, older
 * keys stay published in the JWKS until in-flight grants drain, then drop
 * them. Generate a key with:
 *   node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>console.log(JSON.stringify({kid:crypto.randomUUID(),...await crypto.subtle.exportKey('jwk',k.privateKey)})))"
 */

// Canonical definition lives in ~/lib/constants, beside the other provider ids.
export { ATPROTO_PROVIDER_ID } from "~/lib/constants";

/** The identity-only scope: what a fresh link requests. */
export const ATPROTO_SCOPE = "atproto";

/**
 * The standard.site social permission set: repo write to
 * `site.standard.graph.subscription` and `site.standard.graph.recommend`.
 * Exporting Feeds as Publication subscriptions needs it.
 */
export const ATPROTO_SOCIAL_SCOPE = "include:site.standard.authSocial";

/**
 * The full grant: identity plus the social set. Sign-in and sign-up request
 * it (every sign-in replaces the stored grant, so a narrower sign-in would
 * strip write scope from a user who exports subscriptions), and a Consent
 * upgrade requests it for a linked connection that needs to write. Linking
 * stays identity-only.
 */
export const ATPROTO_FULL_SCOPE = `${ATPROTO_SCOPE} ${ATPROTO_SOCIAL_SCOPE}`;

/**
 * Scopes this instance is allowed to request. upgrade() validates against
 * this so a future caller cannot request an arbitrary grant; broaden it
 * deliberately (per space-delimited token) as capabilities are wired.
 */
export const ATPROTO_ALLOWED_SCOPES = new Set([
  ATPROTO_SCOPE,
  ATPROTO_SOCIAL_SCOPE,
]);

function scopeTokens(scope: string): string[] {
  return scope.trim().split(/\s+/).filter(Boolean);
}

/**
 * Whether a stored grant covers subscription writes. The stored scope is
 * the authorization server's own claim about what it granted, so it
 * decides only whether Serial can skip the consent step. An authorization
 * server that overstates a grant merely skips its own user's consent
 * screen and fails their later writes; it reaches no other repository.
 * Permission sets may be expanded into repo grants by the provider.
 */
export function hasAtprotoWriteScope(
  scope: string | null | undefined,
): boolean {
  const tokens = scopeTokens(scope ?? "");
  if (tokens.includes(ATPROTO_SOCIAL_SCOPE)) return true;
  const permissions = tokens.flatMap((token) => {
    try {
      const permission = RepoPermission.fromString(token);
      return permission ? [permission] : [];
    } catch {
      // Invalid percent encoding in a positional collection can throw.
      return [];
    }
  });
  return REPO_ACTIONS.every((action) =>
    permissions.some((permission) =>
      permission.matches({
        collection: STANDARD_SITE_COLLECTIONS.subscription,
        action,
      }),
    ),
  );
}

/**
 * The tokens of a previously granted scope this instance may request
 * again, so a reconnect restores what the user consented to without ever
 * forwarding an unknown token. Falls back to the identity scope.
 */
export function retainAllowedAtprotoScope(
  scope: string | null | undefined,
): string {
  // Request the declared permission set again, never arbitrary expanded tokens.
  if (hasAtprotoWriteScope(scope)) return ATPROTO_FULL_SCOPE;
  const allowed = scopeTokens(scope ?? "").filter((token) =>
    ATPROTO_ALLOWED_SCOPES.has(token),
  );
  return allowed.length > 0 ? allowed.join(" ") : ATPROTO_SCOPE;
}

/**
 * Reject an authorization scope that is not on the allowlist. Scope is a
 * space-delimited token list; every token must be allowed.
 */
export function assertAllowedAtprotoScope(scope: string): void {
  const tokens = scopeTokens(scope);
  if (tokens.length === 0) {
    throw new Error("An AT Protocol scope is required");
  }
  for (const token of tokens) {
    if (!ATPROTO_ALLOWED_SCOPES.has(token)) {
      throw new Error(`Disallowed AT Protocol scope: ${token}`);
    }
  }
}

/** Upper bound on the life of an in-flight authorization attempt. */
export const AUTH_STATE_TTL_MS = 60 * 60 * 1000;

/** Lazy so importing constants from this module never requires env. */
const baseUrl = () => env.PUBLIC_BASE_URL.replace(/\/$/, "");

/** Shared prefix for every atproto route; the rate-limit catch-all keys on it. */
export const ATPROTO_ROUTE_PREFIX = "/atproto/";

/**
 * Every atproto route, relative to the Better Auth mount (the form plugin
 * endpoints and policy classifiers see). `ATPROTO_PATHS` below is the same
 * set as absolute URL paths for the published client metadata — one source,
 * so a rename can't desynchronize the registered redirect_uris from the
 * routes and gates that serve them.
 */
export const ATPROTO_ROUTES = {
  clientMetadata: `${ATPROTO_ROUTE_PREFIX}client-metadata.json`,
  jwks: `${ATPROTO_ROUTE_PREFIX}jwks.json`,
  authorize: `${ATPROTO_ROUTE_PREFIX}authorize`,
  callback: `${ATPROTO_ROUTE_PREFIX}callback`,
  typeahead: `${ATPROTO_ROUTE_PREFIX}typeahead`,
  // Link flows land on their own registered redirect URI so the policy
  // classifiers in server/auth/index.tsx (which gate the sign-in callback
  // path) never treat an add-on link as a sign-in or roll it back.
  linkCallback: `${ATPROTO_ROUTE_PREFIX}link-callback`,
  // A Consent upgrade lands on its own redirect URI for the same reason:
  // it broadens an existing connection's grant and must never be treated
  // as a sign-in.
  upgradeCallback: `${ATPROTO_ROUTE_PREFIX}upgrade-callback`,
} as const;

const AUTH_MOUNT = "/api/auth";

export const ATPROTO_PATHS = {
  clientMetadata: `${AUTH_MOUNT}${ATPROTO_ROUTES.clientMetadata}`,
  jwks: `${AUTH_MOUNT}${ATPROTO_ROUTES.jwks}`,
  callback: `${AUTH_MOUNT}${ATPROTO_ROUTES.callback}`,
  linkCallback: `${AUTH_MOUNT}${ATPROTO_ROUTES.linkCallback}`,
  upgradeCallback: `${AUTH_MOUNT}${ATPROTO_ROUTES.upgradeCallback}`,
} as const;

/** https everywhere except the dev loopback client's 127.0.0.1 URIs. */
export type AtprotoRedirectUri =
  `https://${string}` | `http://127.0.0.1:${string}`;

/**
 * Base URL the registered redirect URIs are built from. The dev loopback
 * client must register them on a loopback IP — RFC 8252 forbids the
 * "localhost" hostname there — so a localhost base maps to 127.0.0.1; QA
 * the flow in the browser on that origin so the callback's session cookie
 * lands on the host serving the app.
 */
function redirectBaseUrl(): string {
  if (getAtprotoClientMode() !== "loopback") return baseUrl();
  const url = new URL(baseUrl());
  url.hostname = "127.0.0.1";
  return url.toString().replace(/\/$/, "");
}

/**
 * Absolute redirect URI of a registered callback path. authorize()
 * defaults to the first registered redirect URI (the sign-in callback);
 * link and upgrade flows pass theirs explicitly at both the authorize and
 * the code-exchange leg. PUBLIC_BASE_URL is https-served everywhere
 * atproto is enabled except the dev loopback client (the authorization
 * server refuses other plain-http redirect URIs anyway); the assertion
 * satisfies the SDK's template-literal redirect_uri type.
 */
function redirectUriFor(path: string): AtprotoRedirectUri {
  return `${redirectBaseUrl()}${path}` as AtprotoRedirectUri;
}

export function getAtprotoLinkRedirectUri(): AtprotoRedirectUri {
  return redirectUriFor(ATPROTO_PATHS.linkCallback);
}

export function getAtprotoUpgradeRedirectUri(): AtprotoRedirectUri {
  return redirectUriFor(ATPROTO_PATHS.upgradeCallback);
}

/** Order matters: the SDK defaults to the first entry, the sign-in callback. */
function registeredRedirectUris(base: string): [string, ...string[]] {
  return [
    `${base}${ATPROTO_PATHS.callback}`,
    `${base}${ATPROTO_PATHS.linkCallback}`,
    `${base}${ATPROTO_PATHS.upgradeCallback}`,
  ];
}

export function getAtprotoClientMetadata(): OAuthClientMetadataInput {
  // A plain-http loopback base URL gets the SDK's RFC 8252 development
  // client: `http://localhost` client_id carrying the
  // real scope and redirect URIs in its query, auth method "none". It is
  // the only client shape an authorization server accepts from a
  // non-https origin, and Bluesky's servers accept it, so the full round
  // trip is testable locally. Confidential-client behavior
  // (private_key_jwt, metadata/JWKS documents) still needs an https
  // deployment to validate.
  if (getAtprotoClientMode() === "loopback") {
    return buildAtprotoLoopbackClientMetadata({
      scope: ATPROTO_FULL_SCOPE,
      redirect_uris: registeredRedirectUris(redirectBaseUrl()),
    });
  }
  const base = baseUrl();
  return {
    client_id: `${base}${ATPROTO_PATHS.clientMetadata}`,
    client_name: "Serial",
    client_uri: base,
    redirect_uris: registeredRedirectUris(base),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // The metadata scope bounds every grant this client may request, so it
    // carries the full set; individual flows request subsets.
    scope: ATPROTO_FULL_SCOPE,
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}${ATPROTO_PATHS.jwks}`,
  };
}

let keysetPromise: Promise<JoseKey[]> | null = null;

/**
 * Parse and import the confidential-client keyset. The first key signs;
 * every key is published in the JWKS.
 */
export function getAtprotoKeyset(): Promise<JoseKey[]> {
  if (!keysetPromise) {
    keysetPromise = importKeyset(env.ATPROTO_CLIENT_PRIVATE_KEYS!);
    keysetPromise.catch(() => {
      // Allow a retry after a transient failure rather than caching it.
      keysetPromise = null;
    });
  }
  return keysetPromise;
}

async function importKeyset(rawKeys: string): Promise<JoseKey[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error(
      "ATPROTO_CLIENT_PRIVATE_KEYS must be a JSON array of ES256 private JWKs",
    );
  }
  const jwks = Array.isArray(parsed) ? parsed : [parsed];
  if (jwks.length === 0) {
    throw new Error(
      "ATPROTO_CLIENT_PRIVATE_KEYS must contain at least one key",
    );
  }
  return Promise.all(
    jwks.map(async (rawJwk, i) => {
      const jwk = normalizeJwk(rawJwk);
      const fallbackKid =
        typeof jwk === "object" && jwk !== null && "kid" in jwk && jwk.kid
          ? undefined
          : `serial-atproto-${i}`;
      try {
        return await JoseKey.fromImportable(jwk as never, fallbackKid);
      } catch (cause) {
        throw new Error(
          `ATPROTO_CLIENT_PRIVATE_KEYS entry ${i} is not an importable private key`,
          { cause },
        );
      }
    }),
  );
}

/**
 * Strip WebCrypto export artifacts. `key_ops: ["sign"]` on a private JWK is
 * interpreted by @atproto/jwk as public-key usage and would make the key
 * unusable for signing; `ext`/`use` are likewise noise for a server-held
 * signing keyset whose usage is fixed by context.
 */
function normalizeJwk(jwk: unknown): unknown {
  if (typeof jwk !== "object" || jwk === null) return jwk;
  const rest = { ...(jwk as Record<string, unknown>) };
  delete rest.key_ops;
  delete rest.ext;
  delete rest.use;
  return rest;
}

let storeKey: Buffer | null = null;

export function getStoreEncryptionKey(): Buffer {
  storeKey ??= parseEncryptionKey(env.ATPROTO_STORE_ENCRYPTION_KEY!);
  return storeKey;
}

/**
 * Parse both configured values eagerly so a malformed key fails startup
 * with its parse error instead of surfacing at the first user sign-in.
 * Called when the plugin is constructed (module init of the auth surface):
 * the store key parse throws synchronously into that import; the keyset
 * import is async, so its failure exits the process with the message.
 */
export function validateAtprotoConfigAtStartup(
  onKeysetError: (err: unknown) => void,
): void {
  getStoreEncryptionKey();
  getAtprotoKeyset().catch(onKeysetError);
}

/**
 * Deterministic internal placeholder email for a DID-only user. Never
 * surfaced in UI and never deliverable (`.invalid` is reserved). The suffix
 * is keyed with the instance secret so the address is not computable from
 * the (public) DID — Better Auth's account lookup falls back to email
 * matching, and a predictable address would let anyone squat a DID's slot
 * by registering it as a normal email account first. The keyed suffix also
 * keeps distinct DIDs collision-free after sanitizing.
 */
export function placeholderEmailForDid(did: string): string {
  const sanitized = did.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  const suffix = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(did)
    .digest("hex")
    .slice(0, 16);
  return `${sanitized}.${suffix}@${ATPROTO_PLACEHOLDER_EMAIL_DOMAIN}`;
}

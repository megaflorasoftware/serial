export const IS_MAIN_INSTANCE =
  String(import.meta.env.VITE_PUBLIC_IS_MAIN_INSTANCE) === "true" ||
  String(process.env.VITE_PUBLIC_IS_MAIN_INSTANCE) === "true";

export const BASE_SIGNED_OUT_URL = IS_MAIN_INSTANCE
  ? "/welcome"
  : "/auth/sign-in";

export function getBlogUrl(path = "") {
  if (IS_MAIN_INSTANCE) return `/blog${path}`;
  return `https://serial.tube/blog${path}`;
}

/**
 * Parse the public signup config value consistently.
 * Default: signups are ENABLED if not explicitly set to "true"
 */
export function isPublicSignupEnabled(
  configValue: string | undefined | null,
): boolean {
  return configValue === "true";
}

export type AuthProvider = "email" | "oauth";

const DEFAULT_AUTH_PROVIDERS: AuthProvider[] = ["email"];

/**
 * Parse the enabled-auth-providers config value.
 * Returns the list of enabled auth providers for sign-up.
 * Default: ["email"]
 */
export function getEnabledAuthProviders(
  configValue: string | undefined | null,
): AuthProvider[] {
  if (!configValue) return DEFAULT_AUTH_PROVIDERS;
  try {
    const parsed = JSON.parse(configValue);
    if (!Array.isArray(parsed)) return DEFAULT_AUTH_PROVIDERS;
    return parsed.filter(
      (p: unknown): p is AuthProvider => p === "email" || p === "oauth",
    );
  } catch {
    return DEFAULT_AUTH_PROVIDERS;
  }
}

/**
 * Whether OAuth env vars are fully configured.
 */
export function isOAuthConfigured(): boolean {
  const providerId = process.env.OAUTH_PROVIDER_ID;
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  const hasDiscovery = !!process.env.OAUTH_DISCOVERY_URL;
  const hasManualUrls =
    !!process.env.OAUTH_AUTHORIZATION_URL && !!process.env.OAUTH_TOKEN_URL;

  return (
    !!providerId &&
    !!clientId &&
    !!clientSecret &&
    (hasDiscovery || hasManualUrls)
  );
}

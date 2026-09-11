import { SDK_METADATA } from "@polar-sh/sdk/lib/config.js";
import { HTTPClient } from "@polar-sh/sdk/lib/http.js";

export const POLAR_VERSION_HEADER = "Polar-Version";

const POLAR_API_VERSION_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Resolves the Polar date-based API version (YYYY-MM) to pin every request to.
 * The SDK records the spec version its models were generated from, and inbound
 * webhook parsing already follows that version, so outbound requests must too.
 * SDKs built before Polar introduced versioning report a non-date value here.
 */
export function resolvePolarApiVersion(specVersion: string): string {
  if (!POLAR_API_VERSION_PATTERN.test(specVersion)) {
    throw new Error(
      `Polar SDK spec version "${specVersion}" is not a date-based API version (YYYY-MM).`,
    );
  }
  return specVersion;
}

export const POLAR_API_VERSION = resolvePolarApiVersion(
  SDK_METADATA.openapiDocVersion,
);

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

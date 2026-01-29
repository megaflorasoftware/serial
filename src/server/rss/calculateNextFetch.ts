import type { FeedFetchMetadata } from "./types";

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * ONE_HOUR_MS; // Cap at 24 hours
const DEFAULT_INTERVAL_MS = ONE_HOUR_MS; // Default to 1 hour

const UPDATE_PERIOD_MS: Record<
  NonNullable<FeedFetchMetadata["updatePeriod"]>,
  number
> = {
  hourly: ONE_HOUR_MS,
  daily: 24 * ONE_HOUR_MS,
  weekly: 7 * 24 * ONE_HOUR_MS,
  monthly: 30 * 24 * ONE_HOUR_MS,
  yearly: 365 * 24 * ONE_HOUR_MS,
};

/**
 * Calculate the next fetch time for a feed based on HTTP headers and RSS metadata.
 *
 * Priority order:
 * 1. HTTP Cache-Control: max-age
 * 2. HTTP Expires header
 * 3. RSS <ttl> element (minutes)
 * 4. sy:updatePeriod / sy:updateFrequency (Syndication module)
 * 5. Default fallback (60 minutes)
 *
 * All intervals are capped at 24 hours to handle misconfigured servers.
 */
export function calculateNextFetch(
  metadata: FeedFetchMetadata,
  now: Date = new Date(),
): Date {
  const nowMs = now.getTime();

  // 1. HTTP Cache-Control: max-age
  if (metadata.cacheControlMaxAge !== undefined) {
    const intervalMs = Math.min(
      metadata.cacheControlMaxAge * 1000,
      MAX_INTERVAL_MS,
    );
    return new Date(nowMs + intervalMs);
  }

  // 2. HTTP Expires header
  if (metadata.expires) {
    const expiresMs = metadata.expires.getTime();
    // If expires is in the past or too far in the future, apply cap
    const intervalMs = Math.min(
      Math.max(expiresMs - nowMs, 0),
      MAX_INTERVAL_MS,
    );
    return new Date(nowMs + intervalMs);
  }

  // 3. RSS <ttl> element (value is in minutes)
  if (metadata.ttl !== undefined) {
    const intervalMs = Math.min(metadata.ttl * 60 * 1000, MAX_INTERVAL_MS);
    return new Date(nowMs + intervalMs);
  }

  // 4. sy:updatePeriod / sy:updateFrequency
  if (metadata.updatePeriod) {
    const periodMs = UPDATE_PERIOD_MS[metadata.updatePeriod];
    const frequency = metadata.updateFrequency ?? 1;
    // Frequency indicates how many times per period the feed updates
    // So interval = period / frequency
    const intervalMs = Math.min(periodMs / frequency, MAX_INTERVAL_MS);
    return new Date(nowMs + intervalMs);
  }

  // 5. Default fallback
  return new Date(nowMs + DEFAULT_INTERVAL_MS);
}

/**
 * Parse HTTP headers from a fetch Response and extract metadata relevant for caching.
 */
export function parseHttpHeaders(response: Response): FeedFetchMetadata {
  const metadata: FeedFetchMetadata = {};

  // ETag header
  const etag = response.headers.get("etag");
  if (etag) {
    metadata.etag = etag;
  }

  // Last-Modified header
  const lastModified = response.headers.get("last-modified");
  if (lastModified) {
    metadata.lastModified = lastModified;
  }

  // Cache-Control header
  const cacheControl = response.headers.get("cache-control");
  if (cacheControl) {
    const maxAgeMatch = /max-age=(\d+)/.exec(cacheControl);
    if (maxAgeMatch?.[1]) {
      metadata.cacheControlMaxAge = parseInt(maxAgeMatch[1], 10);
    }
  }

  // Expires header
  const expires = response.headers.get("expires");
  if (expires) {
    const expiresDate = new Date(expires);
    if (!isNaN(expiresDate.getTime())) {
      metadata.expires = expiresDate;
    }
  }

  return metadata;
}

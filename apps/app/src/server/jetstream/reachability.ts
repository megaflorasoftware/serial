import { streamFailure } from "./protocol";

/** The failures in which the stream host itself gave out, not this server. */
const HOST_OPERATIONS = new Set([
  "connection",
  "connection-closed",
  "replay-http",
]);

/**
 * The stream host gave no answer: a connection that failed, timed out or
 * dropped, or a server error. A refused position and a rate limit with its
 * own retry delay are answers, and a PDS failure is not the stream host's.
 */
export function hostUnreachable(error: unknown) {
  const failure = streamFailure(error);
  return (
    failure !== undefined &&
    HOST_OPERATIONS.has(failure.operation) &&
    (failure.status === undefined || failure.status >= 500) &&
    failure.retryAfterMs === undefined
  );
}

/**
 * How long one failed contact speaks for the host. It outlasts the stream
 * worker's slowest reconnect, so in the worker's process its failed attempts
 * keep an outage remembered until one succeeds.
 */
const OUTAGE_MEMORY_MS = 2 * 60 * 1000;
const outages = new Map<string, { since: number; failure: unknown }>();

/**
 * This process remembers for a short time that a contact found the stream
 * host unreachable, so the other origins of a batch wait at once instead of
 * each opening a connection. Any contact that succeeds forgets it.
 */
export function rememberOutage(
  service: string,
  failure: unknown,
  now = Date.now(),
) {
  outages.set(service, { since: now, failure });
}

export function forgetOutage(service: string) {
  outages.delete(service);
}

/** The failure a recent contact with the host ended in, while it is remembered. */
export function recentOutage(service: string, now = Date.now()) {
  const outage = outages.get(service);
  if (!outage) return undefined;
  if (now - outage.since < OUTAGE_MEMORY_MS) return outage;
  outages.delete(service);
  return undefined;
}

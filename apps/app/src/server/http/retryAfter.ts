/**
 * The wait a Retry-After header asks for, in milliseconds, from its seconds or
 * its HTTP-date. Undefined when the header is absent or unreadable.
 */
export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

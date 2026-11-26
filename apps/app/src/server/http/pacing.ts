import { AsyncLocalStorage } from "node:async_hooks";
import { parse } from "tldts";
import { retryAfter } from "./retryAfter";
import { errorChain } from "~/server/errorChain";

/** Discovery-side requests in flight to one registrable domain, per process. */
const SITE_REQUESTS_PER_DOMAIN = 6;
/** How long a 429 or 503 pauses discovery when it names no usable wait. */
const DEFAULT_PAUSE_MS = 60_000;
/** The longest pause, whatever wait a site or service names. */
const LONGEST_PAUSE_MS = 60 * 60_000;
/** The most pauses remembered at once. */
const REMEMBERED_PAUSES = 1024;

/**
 * A request that discovery-side work did not send, because its site or
 * service asked discovery to wait. The work may run again from `retryAt`.
 */
export class DiscoveryPausedError extends Error {
  constructor(readonly retryAt: Date) {
    super("Discovery is paused for this site or service");
  }
}

/** A pause for `waitMs`: at most an hour, and a minute when it is unusable. */
function boundedPause(waitMs: number | undefined) {
  return waitMs === undefined || !Number.isFinite(waitMs)
    ? DEFAULT_PAUSE_MS
    : Math.min(Math.max(0, waitMs), LONGEST_PAUSE_MS);
}

/** How long a response's Retry-After header pauses discovery. */
export function pauseLength(retryAfterValue: string | null) {
  return boundedPause(retryAfter(retryAfterValue));
}

/** The end of the pause that held up work failing with `error`, if one did. */
export function pauseEnd(error: unknown) {
  const paused = errorChain(error).find(
    (entry): entry is DiscoveryPausedError =>
      entry instanceof DiscoveryPausedError,
  );
  if (!paused) return undefined;
  const now = Date.now();
  return new Date(now + boundedPause(paused.retryAt.getTime() - now));
}

/**
 * The registrable domain of a hostname, which groups the sites one operator
 * serves. An IP address, or a host with no known public suffix, is its own.
 */
export function registrableDomain(hostname: string) {
  const { domain, isIcann } = parse(hostname);
  return isIcann && domain ? domain : hostname;
}

/**
 * At most `limit` requests in flight for each key. A request waiting for a
 * slot takes the next one released. Once its signal aborts it gives up
 * waiting, or gives its slot back, as it no longer counts as in flight.
 */
export class RequestSlots {
  private readonly keys = new Map<
    string,
    { active: number; waiting: Array<() => void> }
  >();

  constructor(private readonly limit: number) {}

  /** Waits for one of `key`'s slots, and resolves to its release. */
  async take(key: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let slots = this.keys.get(key);
    if (!slots) {
      slots = { active: 0, waiting: [] };
      this.keys.set(key, slots);
    }
    const held = slots;
    if (held.active < this.limit) held.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", giveUp);
          resolve();
        };
        const giveUp = () => {
          held.waiting.splice(held.waiting.indexOf(wake), 1);
          reject(signal!.reason);
        };
        held.waiting.push(wake);
        signal?.addEventListener("abort", giveUp, { once: true });
      });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", release);
      // A waiting request takes the slot over; otherwise it is free.
      const next = held.waiting.shift();
      if (next) next();
      else if (--held.active === 0) this.keys.delete(key);
    };
    if (signal?.aborted) {
      release();
      signal.throwIfAborted();
    }
    signal?.addEventListener("abort", release, { once: true });
    return release;
  }

  /** Runs `send` in one of `key`'s slots. */
  async run<T>(
    key: string,
    signal: AbortSignal | undefined,
    send: () => Promise<T>,
  ) {
    const release = await this.take(key, signal);
    try {
      return await send();
    } finally {
      release();
    }
  }
}

const discoveryWork = new AsyncLocalStorage<true>();
const siteSlots = new RequestSlots(SITE_REQUESTS_PER_DOMAIN);
/** When each paused registrable domain or service host may be asked again. */
const pauses = new Map<string, number>();

/**
 * Runs `work` as discovery-side background work: a subscription sync's find,
 * a Feed revalidation or a light origin check. Its requests are paced. None
 * goes to a site or service that asked discovery to wait, and only a few at a
 * time go to one registrable domain. Anything `work` starts runs as part of
 * it, so waking other work belongs outside.
 */
export function withDiscoveryPacing<T>(work: () => Promise<T>) {
  return discoveryWork.run(true, work);
}

function refuseWhilePaused(key: string) {
  const until = pauses.get(key);
  if (until === undefined) return;
  if (until > Date.now()) throw new DiscoveryPausedError(new Date(until));
  pauses.delete(key);
}

type Answer = {
  status: number;
  headers: { get: (name: string) => string | null };
};

/** A 429 or 503 pauses `key` for its Retry-After, up to an hour, or a minute. */
function pauseOnRefusal(key: string, response: Answer) {
  if (response.status !== 429 && response.status !== 503) return;
  const until = Date.now() + pauseLength(response.headers.get("retry-after"));
  if (!pauses.has(key) && pauses.size >= REMEMBERED_PAUSES)
    pauses.delete(pauses.keys().next().value!);
  pauses.set(key, Math.max(until, pauses.get(key) ?? 0));
}

export type SiteRequest = {
  /** Hears the response. A 429 or 503 pauses discovery for its domain. */
  answered: (response: Answer) => void;
  release: () => void;
};

const UNPACED: SiteRequest = { answered: () => {}, release: () => {} };

/**
 * Starts a request to a site. In discovery-side work it is refused while the
 * site's registrable domain is paused, and otherwise waits for one of the
 * domain's slots until `signal` aborts. Any other request starts at once.
 */
export async function startSiteRequest(
  hostname: string,
  signal?: AbortSignal,
): Promise<SiteRequest> {
  if (!discoveryWork.getStore()) return UNPACED;
  const domain = registrableDomain(hostname);
  refuseWhilePaused(domain);
  const release = await siteSlots.take(domain, signal);
  try {
    // A pause may have begun while it waited.
    refuseWhilePaused(domain);
  } catch (error) {
    release();
    throw error;
  }
  return {
    answered: (response) => pauseOnRefusal(domain, response),
    release,
  };
}

/**
 * Sends a request to an Atmosphere service. In discovery-side work it is
 * refused while the service host is paused, and a 429 or 503 pauses the host.
 */
export async function sendServiceRequest(
  hostname: string,
  send: () => Promise<Response>,
) {
  if (!discoveryWork.getStore()) return send();
  refuseWhilePaused(hostname);
  const response = await send();
  pauseOnRefusal(hostname, response);
  return response;
}

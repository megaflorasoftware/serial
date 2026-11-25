import { env } from "~/env";

type CaptureSurface = "app" | "extension" | "discovery" | "revalidation";

type SurfacePolicy = {
  attempts: number;
  windowMs: number;
  activePerUser: number;
  /**
   * How many of the user's slots background work may hold at once, so the
   * user's own request always finds one free.
   */
  backgroundPerUser?: number;
};

const SURFACE_POLICIES: Record<CaptureSurface, SurfacePolicy> = {
  app: { attempts: 10, windowMs: 10 * 60 * 1_000, activePerUser: 1 },
  extension: { attempts: 30, windowMs: 10 * 60 * 1_000, activePerUser: 2 },
  revalidation: { attempts: 10, windowMs: 10 * 60 * 1_000, activePerUser: 1 },
  // Subscription sync and the Feed origin check queue share the background
  // slots; Add Feed always keeps the third.
  discovery: {
    attempts: 180,
    windowMs: 60 * 1_000,
    activePerUser: 3,
    backgroundPerUser: 2,
  },
};

/** The surfaces whose policy sets aside slots for background work. */
type BackgroundSurface = "discovery";

type GrantedLease = { ok: true; release: () => void };
const RATE_LIMITED = { ok: false, reason: "rate_limited" } as const;

export type CaptureLease =
  { ok: false; reason: "rate_limited" | "capacity_limited" } | GrantedLease;

export class CaptureLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly active = new Map<string, number>();
  private readonly waiting = new Set<() => void>();
  private activeServerFetches = 0;

  constructor(
    private readonly maxServerFetches: number,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(userId: string, surface: CaptureSurface): CaptureLease {
    if (!this.withinRate(userId, surface)) return RATE_LIMITED;
    return (
      this.take(userId, surface, false) ?? {
        ok: false,
        reason: "capacity_limited",
      }
    );
  }

  /**
   * Background work takes its turn instead of being turned away: while no
   * slot it may hold is free, it waits for one to be released. It counts as
   * one attempt however long it waits, and a rate limit still refuses at once.
   * Aborting `signal` gives up the wait, rejecting with its reason.
   */
  async acquireInBackground(
    userId: string,
    surface: BackgroundSurface,
    signal?: AbortSignal,
  ): Promise<GrantedLease | typeof RATE_LIMITED> {
    signal?.throwIfAborted();
    if (!this.withinRate(userId, surface)) return RATE_LIMITED;
    for (;;) {
      const lease = this.take(userId, surface, true);
      if (lease) return lease;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await this.nextRelease(signal);
    }
  }

  /** Each release wakes every waiter; the first to retry takes the slot. */
  private nextRelease(signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const giveUp = () => {
        this.waiting.delete(wake);
        reject(signal!.reason);
      };
      const wake = () => {
        signal?.removeEventListener("abort", giveUp);
        resolve();
      };
      this.waiting.add(wake);
      signal?.addEventListener("abort", giveUp, { once: true });
    });
  }

  /** Records this attempt and reports whether the rolling window allows it. */
  private withinRate(userId: string, surface: CaptureSurface) {
    const policy = SURFACE_POLICIES[surface];
    const key = `${surface}:${userId}`;
    const now = this.now();
    const recentAttempts = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > now - policy.windowMs,
    );
    recentAttempts.push(now);
    this.attempts.set(key, recentAttempts);
    return recentAttempts.length <= policy.attempts;
  }

  /** A slot when the user, their background work and the server have one free. */
  private take(
    userId: string,
    surface: CaptureSurface,
    background: boolean,
  ): GrantedLease | null {
    const policy = SURFACE_POLICIES[surface];
    const userKey = `${surface}:${userId}`;
    const backgroundKey = `${surface}:background:${userId}`;
    const usesServerCapacity = surface !== "extension";
    if (
      (this.active.get(userKey) ?? 0) >= policy.activePerUser ||
      (background &&
        (this.active.get(backgroundKey) ?? 0) >=
          (policy.backgroundPerUser ?? 0)) ||
      (usesServerCapacity && this.activeServerFetches >= this.maxServerFetches)
    )
      return null;

    const keys = background ? [userKey, backgroundKey] : [userKey];
    for (const key of keys)
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
    if (usesServerCapacity) this.activeServerFetches += 1;
    let released = false;

    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        for (const key of keys) {
          const active = this.active.get(key) ?? 1;
          if (active <= 1) this.active.delete(key);
          else this.active.set(key, active - 1);
        }
        if (usesServerCapacity) this.activeServerFetches -= 1;
        const waiting = [...this.waiting];
        this.waiting.clear();
        for (const wake of waiting) wake();
      },
    };
  }
}

export const captureLimiter = new CaptureLimiter(
  env.SERIAL_CAPTURE_MAX_CONCURRENT_FETCHES,
);

import { env } from "~/env";

type CaptureSurface = "app" | "extension" | "discovery" | "revalidation";

type SurfacePolicy = {
  attempts: number;
  windowMs: number;
  activePerUser: number;
  /**
   * Background work's own share: how many of the user's slots it may hold at
   * once, so the user's own request always finds one free, and an allowance
   * of attempts apart from the user's.
   */
  background?: { activePerUser: number; attempts: number };
};

const SURFACE_POLICIES: Record<CaptureSurface, SurfacePolicy> = {
  app: { attempts: 10, windowMs: 10 * 60 * 1_000, activePerUser: 1 },
  extension: { attempts: 30, windowMs: 10 * 60 * 1_000, activePerUser: 2 },
  revalidation: { attempts: 10, windowMs: 10 * 60 * 1_000, activePerUser: 1 },
  // Subscription sync and the Feed origin check queue share the background
  // slots and allowance; Add Feed always keeps the fifth slot and its own 180.
  discovery: {
    attempts: 180,
    windowMs: 60 * 1_000,
    activePerUser: 5,
    background: { activePerUser: 4, attempts: 360 },
  },
};

/** The surfaces whose policy sets aside slots for background work. */
type BackgroundSurface = "discovery";

/** Server-wide fetches that only what users ask for themselves may take. */
const INTERACTIVE_SERVER_RESERVE = 2;

type GrantedLease = { ok: true; release: () => void };
const RATE_LIMITED = { ok: false, reason: "rate_limited" } as const;

export type CaptureLease =
  { ok: false; reason: "rate_limited" | "capacity_limited" } | GrantedLease;

export class CaptureLimiter {
  private readonly attempts = new Map<string, number[]>();
  /** Slots held, per user share and server-wide. */
  private readonly active = new Map<string, number>();
  private readonly waiting = new Set<() => void>();
  /** Background work always gets one, however small the configured cap. */
  private readonly maxBackgroundServerFetches: number;

  constructor(
    private readonly maxServerFetches: number,
    private readonly now: () => number = Date.now,
  ) {
    this.maxBackgroundServerFetches = Math.max(
      1,
      maxServerFetches - INTERACTIVE_SERVER_RESERVE,
    );
  }

  acquire(userId: string, surface: CaptureSurface): CaptureLease {
    if (!this.withinRate(userId, surface, false)) return RATE_LIMITED;
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
   * one attempt of its own allowance however long it waits, and a rate limit
   * still refuses at once.
   * Aborting `signal` gives up the wait, rejecting with its reason.
   */
  async acquireInBackground(
    userId: string,
    surface: BackgroundSurface,
    signal?: AbortSignal,
  ): Promise<GrantedLease | typeof RATE_LIMITED> {
    signal?.throwIfAborted();
    if (!this.withinRate(userId, surface, true)) return RATE_LIMITED;
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
  private withinRate(
    userId: string,
    surface: CaptureSurface,
    background: boolean,
  ) {
    const policy = SURFACE_POLICIES[surface];
    const [key, attempts] = background
      ? [`${surface}:background:${userId}`, policy.background?.attempts ?? 0]
      : [`${surface}:${userId}`, policy.attempts];
    const now = this.now();
    const recentAttempts = (this.attempts.get(key) ?? []).filter(
      (timestamp) => timestamp > now - policy.windowMs,
    );
    recentAttempts.push(now);
    this.attempts.set(key, recentAttempts);
    return recentAttempts.length <= attempts;
  }

  /**
   * A slot when every share it counts against has one free: the user's,
   * their background work's, and the server's, of which background work
   * leaves some for what users ask for themselves.
   */
  private take(
    userId: string,
    surface: CaptureSurface,
    background: boolean,
  ): GrantedLease | null {
    const policy = SURFACE_POLICIES[surface];
    const shares: Array<[key: string, limit: number]> = [
      [`${surface}:${userId}`, policy.activePerUser],
    ];
    if (surface !== "extension") shares.push(["server", this.maxServerFetches]);
    if (background)
      shares.push(
        [
          `${surface}:background:${userId}`,
          policy.background?.activePerUser ?? 0,
        ],
        ["server:background", this.maxBackgroundServerFetches],
      );
    if (shares.some(([key, limit]) => (this.active.get(key) ?? 0) >= limit))
      return null;

    for (const [key] of shares)
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
    let released = false;

    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        for (const [key] of shares) {
          const active = this.active.get(key) ?? 1;
          if (active <= 1) this.active.delete(key);
          else this.active.set(key, active - 1);
        }
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

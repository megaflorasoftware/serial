import { describe, expect, it, vi } from "vitest";
import { CaptureLimiter } from "~/server/bookmarks/limits";

describe("capture limits", () => {
  it("rejects concurrent app attempts per user and deployment", () => {
    const limiter = new CaptureLimiter(1);
    const first = limiter.acquire("one", "app");
    expect(first.ok).toBe(true);
    expect(limiter.acquire("one", "app")).toEqual({
      ok: false,
      reason: "capacity_limited",
    });
    expect(limiter.acquire("two", "app")).toEqual({
      ok: false,
      reason: "capacity_limited",
    });
    if (first.ok) first.release();
    expect(limiter.acquire("two", "app").ok).toBe(true);
  });

  it("counts rejected attempts toward the rolling rate window", () => {
    let now = 0;
    const limiter = new CaptureLimiter(1, () => now);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const lease = limiter.acquire("one", "app");
      expect(lease.ok).toBe(true);
      if (lease.ok) lease.release();
    }
    expect(limiter.acquire("one", "app")).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    now = 10 * 60 * 1_000 + 1;
    expect(limiter.acquire("one", "app").ok).toBe(true);
  });

  it("permits two extension ingestions per user", () => {
    const limiter = new CaptureLimiter(1);
    const first = limiter.acquire("one", "extension");
    const second = limiter.acquire("one", "extension");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(limiter.acquire("one", "extension")).toEqual({
      ok: false,
      reason: "capacity_limited",
    });
  });

  it("shares deployment fetch capacity between capture and Feed discovery", () => {
    const limiter = new CaptureLimiter(1);
    const capture = limiter.acquire("one", "app");
    expect(capture.ok).toBe(true);
    expect(limiter.acquire("two", "discovery")).toEqual({
      ok: false,
      reason: "capacity_limited",
    });
    if (capture.ok) capture.release();

    const discovery = limiter.acquire("two", "discovery");
    expect(discovery.ok).toBe(true);
    expect(limiter.acquire("three", "app")).toEqual({
      ok: false,
      reason: "capacity_limited",
    });
    if (discovery.ok) discovery.release();
  });
});

it("allows a minute of discovery typing while bounding requests and concurrent work", () => {
  let now = 0;
  const limiter = new CaptureLimiter(8, () => now);
  for (let attempt = 0; attempt < 180; attempt++) {
    const lease = limiter.acquire("typing", "discovery");
    expect(lease.ok).toBe(true);
    if (lease.ok) lease.release();
  }
  expect(limiter.acquire("typing", "discovery")).toEqual({
    ok: false,
    reason: "rate_limited",
  });
  now = 60_000;
  const leases = [1, 2, 3].map(() => limiter.acquire("typing", "discovery"));
  expect(leases.every((lease) => lease.ok)).toBe(true);
  expect(limiter.acquire("typing", "discovery")).toEqual({
    ok: false,
    reason: "capacity_limited",
  });
  for (const lease of leases) if (lease.ok) lease.release();
});

describe("background discovery", () => {
  it("holds at most two of a user's three slots, so Add Feed always finds one", async () => {
    const limiter = new CaptureLimiter(8);
    const sync = await limiter.acquireInBackground("one", "discovery");
    const queue = await limiter.acquireInBackground("one", "discovery");
    expect(sync.ok && queue.ok).toBe(true);
    let third: Awaited<ReturnType<typeof limiter.acquireInBackground>> | null =
      null;
    void limiter
      .acquireInBackground("one", "discovery")
      .then((lease) => (third = lease));
    await Promise.resolve();
    expect(third).toBeNull();
    const add = limiter.acquire("one", "discovery");
    expect(add.ok).toBe(true);
    // Another user's slots are their own.
    expect((await limiter.acquireInBackground("two", "discovery")).ok).toBe(
      true,
    );
    if (add.ok) add.release();
    await Promise.resolve();
    // A freed slot the user's own work held does not lift the background cap.
    expect(third).toBeNull();
    if (sync.ok) sync.release();
    await vi.waitFor(() => expect(third).toMatchObject({ ok: true }));
  });

  it("waits for server capacity instead of being turned away", async () => {
    const limiter = new CaptureLimiter(1);
    const capture = limiter.acquire("other", "app");
    let lease: Awaited<ReturnType<typeof limiter.acquireInBackground>> | null =
      null;
    void limiter
      .acquireInBackground("one", "discovery")
      .then((granted) => (lease = granted));
    await Promise.resolve();
    expect(lease).toBeNull();
    if (capture.ok) capture.release();
    await vi.waitFor(() => expect(lease).toMatchObject({ ok: true }));
  });

  it("counts one attempt however long it waits, and still refuses a rate limit at once", async () => {
    let now = 0;
    const limiter = new CaptureLimiter(8, () => now);
    const held = await Promise.all(
      [1, 2].map(() => limiter.acquireInBackground("one", "discovery")),
    );
    const waiting = limiter.acquireInBackground("one", "discovery");
    for (let release = 0; release < 5; release++) {
      // Releases of the user's own lease wake the waiter without a slot for it.
      const own = limiter.acquire("one", "discovery");
      if (own.ok) own.release();
      await Promise.resolve();
    }
    // Two held, one waiting and five of the user's own: eight attempts.
    for (let attempt = 0; attempt < 172; attempt++) {
      const lease = limiter.acquire("one", "discovery");
      if (lease.ok) lease.release();
    }
    expect(await limiter.acquireInBackground("one", "discovery")).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    for (const lease of held) if (lease.ok) lease.release();
    expect((await waiting).ok).toBe(true);
    now = 60_001;
    expect((await limiter.acquireInBackground("two", "discovery")).ok).toBe(
      true,
    );
  });
});

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
  const leases = [1, 2, 3, 4, 5].map(() =>
    limiter.acquire("typing", "discovery"),
  );
  expect(leases.every((lease) => lease.ok)).toBe(true);
  expect(limiter.acquire("typing", "discovery")).toEqual({
    ok: false,
    reason: "capacity_limited",
  });
  for (const lease of leases) if (lease.ok) lease.release();
});

const RATE_LIMITED = { ok: false, reason: "rate_limited" };
type BackgroundLease = Awaited<
  ReturnType<CaptureLimiter["acquireInBackground"]>
>;
/** Starts a background wait and reports its lease once granted. */
function waitInBackground(limiter: CaptureLimiter, userId: string) {
  const wait = { lease: null as BackgroundLease | null };
  void limiter
    .acquireInBackground(userId, "discovery")
    .then((lease) => (wait.lease = lease));
  return wait;
}
const holdInBackground = (
  limiter: CaptureLimiter,
  userId: string,
  count: number,
) =>
  Promise.all(
    Array.from({ length: count }, () =>
      limiter.acquireInBackground(userId, "discovery"),
    ),
  );
const release = (leases: Array<{ ok: boolean; release?: () => void }>) => {
  for (const lease of leases) lease.release?.();
};

describe("background discovery", () => {
  it("holds at most four of a user's five slots, so Add Feed always finds one", async () => {
    const limiter = new CaptureLimiter(8);
    const held = await holdInBackground(limiter, "one", 4);
    expect(held.every((lease) => lease.ok)).toBe(true);
    const fifth = waitInBackground(limiter, "one");
    await Promise.resolve();
    expect(fifth.lease).toBeNull();
    const add = limiter.acquire("one", "discovery");
    expect(add.ok).toBe(true);
    // Another user's slots are their own.
    expect((await limiter.acquireInBackground("two", "discovery")).ok).toBe(
      true,
    );
    if (add.ok) add.release();
    await Promise.resolve();
    // A freed slot the user's own work held does not lift the background cap.
    expect(fifth.lease).toBeNull();
    release(held.slice(0, 1));
    await vi.waitFor(() => expect(fifth.lease).toMatchObject({ ok: true }));
  });

  it("waits for server capacity instead of being turned away", async () => {
    const limiter = new CaptureLimiter(1);
    const capture = limiter.acquire("other", "app");
    const wait = waitInBackground(limiter, "one");
    await Promise.resolve();
    expect(wait.lease).toBeNull();
    if (capture.ok) capture.release();
    await vi.waitFor(() => expect(wait.lease).toMatchObject({ ok: true }));
  });

  it("leaves two of the server's fetches to what users ask for themselves", async () => {
    const limiter = new CaptureLimiter(8);
    const held = [
      ...(await holdInBackground(limiter, "one", 4)),
      ...(await holdInBackground(limiter, "two", 2)),
    ];
    // "two" has background slots of its own left, but the server has none.
    const waiting = waitInBackground(limiter, "two");
    await Promise.resolve();
    expect(waiting.lease).toBeNull();
    const add = limiter.acquire("three", "discovery");
    const capture = limiter.acquire("four", "app");
    expect(add.ok && capture.ok).toBe(true);
    expect(limiter.acquire("five", "revalidation")).toEqual({
      ok: false,
      reason: "capacity_limited",
    });
    if (add.ok) add.release();
    // The Edit dialog's revalidation takes the fetch Add Feed gave back.
    expect(limiter.acquire("five", "revalidation").ok).toBe(true);
    await Promise.resolve();
    expect(waiting.lease).toBeNull();
    release(held.slice(0, 1));
    await vi.waitFor(() => expect(waiting.lease).toMatchObject({ ok: true }));
  });

  it.each([1, 2, 3])(
    "still runs background work one at a time under a server cap of %i",
    async (cap) => {
      const limiter = new CaptureLimiter(cap);
      const [first] = await holdInBackground(limiter, "one", 1);
      expect(first?.ok).toBe(true);
      const second = waitInBackground(limiter, "two");
      await Promise.resolve();
      expect(second.lease).toBeNull();
      if (first?.ok) first.release();
      await vi.waitFor(() => expect(second.lease).toMatchObject({ ok: true }));
    },
  );

  it("drops a wait its caller gave up on, leaving the slot to the next", async () => {
    const limiter = new CaptureLimiter(8);
    const held = await holdInBackground(limiter, "one", 4);
    const stop = new AbortController();
    const abandoned = limiter.acquireInBackground(
      "one",
      "discovery",
      stop.signal,
    );
    stop.abort(new Error("run ended"));
    await expect(abandoned).rejects.toThrow("run ended");
    const next = limiter.acquireInBackground("one", "discovery");
    release(held.slice(0, 1));
    expect(await next).toMatchObject({ ok: true });
    // The abandoned wait took nothing: the user's own slot is still free.
    expect(limiter.acquire("one", "discovery").ok).toBe(true);
    await expect(
      limiter.acquireInBackground("one", "discovery", stop.signal),
    ).rejects.toThrow("run ended");
  });

  it("counts one attempt however long it waits, against an allowance of its own", async () => {
    let now = 0;
    const limiter = new CaptureLimiter(8, () => now);
    const held = await holdInBackground(limiter, "one", 4);
    const waiting = limiter.acquireInBackground("one", "discovery");
    for (let wake = 0; wake < 5; wake++) {
      // Releases of the user's own lease wake the waiter without a slot for it.
      const own = limiter.acquire("one", "discovery");
      if (own.ok) own.release();
      await Promise.resolve();
    }
    release(held);
    const woken = await waiting;
    expect(woken.ok).toBe(true);
    if (woken.ok) woken.release();
    // Four held and one waiting: five of background work's 360.
    for (let attempt = 0; attempt < 355; attempt++) {
      const lease = await limiter.acquireInBackground("one", "discovery");
      if (lease.ok) lease.release();
      else expect.fail(`attempt ${attempt} was refused`);
    }
    expect(await limiter.acquireInBackground("one", "discovery")).toEqual(
      RATE_LIMITED,
    );
    // The user's own discovery keeps its 180, five of them spent above.
    for (let attempt = 0; attempt < 175; attempt++) {
      const lease = limiter.acquire("one", "discovery");
      if (lease.ok) lease.release();
      else expect.fail(`attempt ${attempt} was refused`);
    }
    expect(limiter.acquire("one", "discovery")).toEqual(RATE_LIMITED);
    now = 60_001;
    expect((await limiter.acquireInBackground("one", "discovery")).ok).toBe(
      true,
    );
  });
});

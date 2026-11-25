import { createServer } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Server } from "node:http";
import {
  DiscoveryPausedError,
  pauseEnd,
  registrableDomain,
  sendServiceRequest,
  startSiteRequest,
  withDiscoveryPacing,
} from "~/server/http/pacing";
import { readFeedHttp } from "~/server/rss/feedHttp";

/** Lets every request that can start, start. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const answer = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });
const refusal = (pending: Promise<unknown>) =>
  pending.then(
    () => expect.unreachable(),
    (error: unknown) => error as DiscoveryPausedError,
  );

afterEach(() => vi.useRealTimers());

describe("registrable domains", () => {
  it.each([
    ["lab.leaflet.pub", "leaflet.pub"],
    ["eva.leaflet.pub", "leaflet.pub"],
    ["matlfb.pckt.blog", "pckt.blog"],
    ["www.example.co.uk", "example.co.uk"],
    ["writer.substack.com", "substack.com"],
    // A Substack site on its own domain is not grouped with substack.com.
    ["www.platformer.news", "platformer.news"],
    ["127.0.0.1", "127.0.0.1"],
    ["[::1]", "[::1]"],
    ["localhost", "localhost"],
    ["intranet.example-unknown-suffix", "intranet.example-unknown-suffix"],
  ])("groups %s under %s", (hostname, domain) => {
    expect(registrableDomain(hostname)).toBe(domain);
  });
});

describe("discovery-side site requests", () => {
  it("let at most six into one registrable domain at once, and other domains through", async () => {
    await withDiscoveryPacing(async () => {
      const started: number[] = [];
      const requests = Array.from({ length: 8 }, (_, index) =>
        startSiteRequest(`site-${index}.limit-test.com`).then((request) => {
          started.push(index);
          return request;
        }),
      );
      await settle();
      expect(started).toEqual([0, 1, 2, 3, 4, 5]);
      (await startSiteRequest("limit-test.org")).release();
      (await requests[0]!).release();
      await settle();
      expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
      for (const request of requests)
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        (await request).release();
      expect(started).toHaveLength(8);
    });
  });

  it("are the only ones paced", async () => {
    const requests = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        startSiteRequest(`site-${index}.unpaced-test.com`),
      ),
    );
    expect(requests).toHaveLength(8);
  });

  it("give their slot back when their signal aborts, settled or not", async () => {
    await withDiscoveryPacing(async () => {
      const controllers = Array.from(
        { length: 6 },
        () => new AbortController(),
      );
      await Promise.all(
        controllers.map((controller) =>
          startSiteRequest("abandoned-test.com", controller.signal),
        ),
      );
      let started = false;
      const waiting = startSiteRequest("abandoned-test.com").then((request) => {
        started = true;
        return request;
      });
      await settle();
      expect(started).toBe(false);
      controllers[0]!.abort();
      (await waiting).release();
      expect(started).toBe(true);
      for (const controller of controllers) controller.abort();
    });
  });

  it("give up waiting for a slot when their signal aborts", async () => {
    await withDiscoveryPacing(async () => {
      const held = await Promise.all(
        Array.from({ length: 6 }, () => startSiteRequest("abort-test.com")),
      );
      const controller = new AbortController();
      const waiting = startSiteRequest("www.abort-test.com", controller.signal);
      controller.abort(new Error("gave up"));
      await expect(waiting).rejects.toThrow("gave up");
      held[0]!.release();
      // The slot went to no one: the next request takes it at once.
      const next = await startSiteRequest("abort-test.com");
      for (const request of [...held, next]) request.release();
    });
  });
});

describe("pauses", () => {
  it("stop discovery-side requests to the whole registrable domain for its Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withDiscoveryPacing(async () => {
      const request = await startSiteRequest("a.pause-test.com");
      request.answered(answer(429, { "Retry-After": "120" }));
      request.release();
      const refused = await refusal(startSiteRequest("b.pause-test.com"));
      expect(refused).toBeInstanceOf(DiscoveryPausedError);
      expect(refused.retryAt.getTime()).toBe(Date.now() + 120_000);
      (await startSiteRequest("pause-test.org")).release();
    });
    // Other work carries on.
    (await startSiteRequest("b.pause-test.com")).release();
    vi.setSystemTime(Date.now() + 120_001);
    await withDiscoveryPacing(async () => {
      (await startSiteRequest("b.pause-test.com")).release();
    });
  });

  it("last a minute after a 503 that names no wait, or until its HTTP-date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const until = new Date(Math.ceil(Date.now() / 1000) * 1000 + 300_000);
    await withDiscoveryPacing(async () => {
      const unavailable = await startSiteRequest("unavailable-test.com");
      unavailable.answered(answer(503));
      unavailable.release();
      const dated = await startSiteRequest("dated-test.com");
      dated.answered(answer(429, { "Retry-After": until.toUTCString() }));
      dated.release();
      expect(
        (await refusal(startSiteRequest("unavailable-test.com"))).retryAt,
      ).toEqual(new Date(Date.now() + 60_000));
      expect(
        (await refusal(startSiteRequest("dated-test.com"))).retryAt,
      ).toEqual(until);
    });
  });

  it("start on no other status", async () => {
    await withDiscoveryPacing(async () => {
      for (const status of [200, 404, 410, 500, 502]) {
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const request = await startSiteRequest("status-test.com");
        request.answered(answer(status, { "Retry-After": "120" }));
        request.release();
      }
      (await startSiteRequest("status-test.com")).release();
    });
  });

  it("refuse a request that was waiting for a slot when one began", async () => {
    await withDiscoveryPacing(async () => {
      const held = await Promise.all(
        Array.from({ length: 6 }, () => startSiteRequest("waiting-test.com")),
      );
      const waiting = refusal(startSiteRequest("www.waiting-test.com"));
      held[0]!.answered(answer(429));
      held[0]!.release();
      expect(await waiting).toBeInstanceOf(DiscoveryPausedError);
      for (const request of held) request.release();
    });
  });

  it("stop discovery-side requests to the service host that refused one", async () => {
    const refusing = vi.fn(() => Promise.resolve(answer(503)));
    const ok = vi.fn(() => Promise.resolve(answer(200)));
    await withDiscoveryPacing(async () => {
      expect(
        (await sendServiceRequest("pds.service-test.com", refusing)).status,
      ).toBe(503);
      expect(
        await refusal(sendServiceRequest("pds.service-test.com", ok)),
      ).toBeInstanceOf(DiscoveryPausedError);
      // A service host is its own: another on the same domain carries on.
      await sendServiceRequest("other.service-test.com", ok);
    });
    await sendServiceRequest("pds.service-test.com", ok);
    expect(refusing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(2);
  });

  it("are found behind the errors that wrap them", () => {
    const retryAt = new Date(Date.now() + 60_000);
    const wrapped = new Error("Resolution failed", {
      cause: new Error("Fetch failed", {
        cause: new DiscoveryPausedError(retryAt),
      }),
    });
    expect(pauseEnd(wrapped)).toBe(retryAt);
    expect(pauseEnd(new Error("Site unavailable"))).toBeUndefined();
  });
});

describe("feed reads in discovery-side work", () => {
  let server: Server;
  let port: number;
  let inFlight = 0;
  let peak = 0;
  let served = 0;
  const local = {
    validateTarget: (value: string) => new URL(value),
    resolveAddresses: () =>
      Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
  };
  const read = (url: string) => readFeedHttp(url, {}, local);

  beforeAll(async () => {
    server = createServer((request, response) => {
      served += 1;
      if (request.url === "/limited") {
        response.writeHead(429, { "Retry-After": "120" });
        response.end();
        return;
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        response.writeHead(200, { "Content-Type": "application/rss+xml" });
        response.end("<rss />");
      }, 20);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it("keep at most six requests in flight to one registrable domain", async () => {
    // Three publications on one host, as a sync's concurrent finds read them.
    const urls = Array.from(
      { length: 18 },
      (_, index) => `http://site-${index % 3}.held-test.com:${port}/${index}`,
    );
    peak = 0;
    const responses = await withDiscoveryPacing(() =>
      Promise.all(urls.map(read)),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(peak).toBe(6);
    peak = 0;
    await Promise.all(urls.map(read));
    expect(peak).toBeGreaterThan(6);
  });

  it("send nothing to a domain a 429 paused", async () => {
    await withDiscoveryPacing(async () => {
      expect(
        (await read(`http://a.paused-test.com:${port}/limited`)).status,
      ).toBe(429);
      const before = served;
      const refused = await refusal(
        read(`http://b.paused-test.com:${port}/feed`),
      );
      expect(refused).toBeInstanceOf(DiscoveryPausedError);
      expect(refused.retryAt.getTime()).toBeGreaterThan(Date.now() + 110_000);
      expect(served).toBe(before);
    });
    expect((await read(`http://b.paused-test.com:${port}/feed`)).ok).toBe(true);
  });
});

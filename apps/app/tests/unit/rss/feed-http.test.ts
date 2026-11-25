import { createServer } from "node:http";
import { fetch as undiciFetch } from "undici";
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
import type { Agent } from "undici";
import {
  BlockedOutboundTargetError,
  createPinnedDispatcher,
  createPinnedPool,
  SERIAL_USER_AGENT,
  validatePublicAddresses,
} from "~/server/http/publicHttp";
import { readFeedHttp } from "~/server/rss/feedHttp";

const LOCAL_HTTP_DEPENDENCIES = {
  validateTarget: (value: string) => new URL(value),
  resolveAddresses: () =>
    Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
};

function readLocalFeedHttp(
  url: string,
  options: Parameters<typeof readFeedHttp>[1] = {},
) {
  return readFeedHttp(url, options, LOCAL_HTTP_DEPENDENCIES);
}

let server: Server;
let baseUrl: string;
let onSlowChunk: (() => void) | undefined;
/** The headers of each request the server received, in order. */
let received: Array<Record<string, string | string[] | undefined>> = [];
let connections = 0;
/** `path` on `host`, served by the local server however `host` resolves. */
const at = (host: string, path: string) =>
  `http://${host}:${new URL(baseUrl).port}${path}`;

beforeAll(async () => {
  server = createServer((request, response) => {
    received.push(request.headers);
    for (const [path, host] of [
      ["/to-b", "b.pool-test.com"],
      ["/to-blocked", "blocked.pool-test.com"],
      ["/to-private", "private.pool-test.com"],
    ] as const)
      if (request.url === path) {
        response.writeHead(302, { Location: at(host, "/feed") });
        response.end();
        return;
      }

    if (request.url === "/redirect-a") {
      response.writeHead(302, { Location: "/redirect-b" });
      response.end();
      return;
    }

    if (request.url === "/redirect-b") {
      response.writeHead(302, { Location: "/feed" });
      response.end();
      return;
    }

    if (request.url === "/feed") {
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.end("<rss />");
      return;
    }

    if (request.url === "/slow") {
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.write("<rss>");
      onSlowChunk?.();
      setTimeout(() => response.end("</rss>"), 100);
      return;
    }

    if (request.url === "/large-headers") {
      response.writeHead(200, {
        "Content-Type": "application/rss+xml",
        "X-Large": "x".repeat(80),
      });
      response.end("<rss />");
      return;
    }
    if (request.url === "/not-modified") {
      response.writeHead(304, { "Content-Length": "1024" });
      response.end();
      return;
    }

    if (request.url === "/declared-oversized") {
      response.writeHead(200, {
        "Content-Length": "65",
        "Content-Type": "application/rss+xml",
      });
      response.end("x".repeat(65));
      return;
    }

    if (request.url === "/three-megabytes") {
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.end(`<rss>${"x".repeat(3 * 1024 * 1024)}</rss>`);
      return;
    }

    if (request.url === "/declared-eleven-megabytes") {
      response.writeHead(200, {
        "Content-Length": `${11 * 1024 * 1024}`,
        "Content-Type": "application/rss+xml",
      });
      response.end();
      return;
    }

    if (request.url === "/oversized") {
      response.writeHead(200, { "Content-Type": "application/rss+xml" });
      response.end("x".repeat(65));
      return;
    }

    response.writeHead(404);
    response.end();
  });
  server.on("connection", () => {
    connections += 1;
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  delete process.env.SERIAL_TEST_RSS_ALLOW_LOOPBACK;
  delete process.env.SERIAL_TEST_RSS_ORIGIN;
});

describe("readFeedHttp", () => {
  it("rejects private-network targets before opening a connection", async () => {
    await expect(readFeedHttp("http://127.0.0.1/feed.xml")).rejects.toThrow(
      "not public",
    );
  });

  it("rejects a configured loopback RSS origin without the test-runner capability", async () => {
    process.env.SERIAL_TEST_RSS_ORIGIN = baseUrl;

    await expect(readFeedHttp(`${baseUrl}/feed`)).rejects.toThrow(
      "not allowed",
    );
  });

  it("allows only the exact loopback RSS origin authorized by the test runner", async () => {
    process.env.SERIAL_TEST_RSS_ALLOW_LOOPBACK = "1";
    process.env.SERIAL_TEST_RSS_ORIGIN = baseUrl;

    await expect(readFeedHttp(`${baseUrl}/feed`)).resolves.toMatchObject({
      status: 200,
      text: "<rss />",
    });
    await expect(readFeedHttp("http://127.0.0.1:9/feed.xml")).rejects.toThrow(
      "not allowed",
    );
    await expect(readFeedHttp("not a URL")).rejects.toThrow("invalid");
  });

  it("rejects a chunked response once its body exceeds the byte budget", async () => {
    await expect(
      readLocalFeedHttp(`${baseUrl}/oversized`, { maxBodyBytes: 64 }),
    ).rejects.toThrow("Feed response body exceeds 64 bytes");
  });

  it("rejects an oversized declared response before reading its body", async () => {
    await expect(
      readLocalFeedHttp(`${baseUrl}/declared-oversized`, { maxBodyBytes: 64 }),
    ).rejects.toThrow("Feed response Content-Length exceeds 64 bytes");
  });

  it("accepts a body larger than 2 MiB under the default budget", async () => {
    const response = await readLocalFeedHttp(`${baseUrl}/three-megabytes`);
    expect(response.status).toBe(200);
    expect(response.text.length).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("rejects a declared body beyond the 10 MiB default budget", async () => {
    await expect(
      readLocalFeedHttp(`${baseUrl}/declared-eleven-megabytes`),
    ).rejects.toThrow(
      `Feed response Content-Length exceeds ${10 * 1024 * 1024} bytes`,
    );
  });

  it("rejects redirect chains beyond the configured budget", async () => {
    await expect(
      readLocalFeedHttp(`${baseUrl}/redirect-a`, { maxRedirects: 1 }),
    ).rejects.toThrow("Feed request exceeded 1 redirect");
  });

  it("aborts the whole redirect-and-body attempt at its duration budget", async () => {
    await expect(
      readLocalFeedHttp(`${baseUrl}/slow`, { totalDurationMs: 20 }),
    ).rejects.toThrow("Feed request exceeded 20ms total duration");
  });

  it("rejects response headers beyond the configured budget", async () => {
    await expect(
      readLocalFeedHttp(`${baseUrl}/large-headers`, { maxHeaderBytes: 64 }),
    ).rejects.toThrow("Feed response headers exceed 64 bytes");
  });

  it("preserves a bodyless 304 with a representation Content-Length", async () => {
    const response = await readLocalFeedHttp(`${baseUrl}/not-modified`, {
      maxBodyBytes: 64,
    });
    expect(response.status).toBe(304);
    expect(response.text).toBe("");
  });
});

it("cancels a body read when its caller aborts", async () => {
  const controller = new AbortController();
  const started = new Promise<void>((resolve) => {
    onSlowChunk = resolve;
  });
  const pending = readLocalFeedHttp(`${baseUrl}/slow`, {
    signal: controller.signal,
  });
  const assertion = expect(pending).rejects.toThrow();
  await started;
  onSlowChunk = undefined;
  controller.abort();
  await assertion;
});

it("names Serial as the User-Agent, keeping the caller's other headers", async () => {
  received = [];
  await readLocalFeedHttp(`${baseUrl}/feed`, {
    headers: { Accept: "application/rss+xml", "User-Agent": "other" },
  });
  expect(received[0]).toMatchObject({
    accept: "application/rss+xml",
    "user-agent": SERIAL_USER_AGENT,
  });
});

/**
 * Local dependencies for pooled reads. Each request records the hostname it
 * went to and the hostname its connection was pinned for.
 */
function pooledDependencies(
  resolve: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>> = () =>
    Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
) {
  const pinnedFor = new Map<Agent, string>();
  const sent: Array<{ hostname: string; pinnedFor?: string }> = [];
  const agents: Agent[] = [];
  return {
    sent,
    agents,
    validateTarget: (value: string) => {
      const target = new URL(value);
      if (target.hostname === "blocked.pool-test.com")
        throw new BlockedOutboundTargetError(
          "The outbound target is not allowed",
        );
      return target;
    },
    resolveAddresses: vi.fn(resolve),
    createDispatcher: vi.fn(
      (input: Parameters<typeof createPinnedDispatcher>[0]) => {
        const agent = createPinnedDispatcher(input);
        vi.spyOn(agent, "close");
        vi.spyOn(agent, "destroy");
        pinnedFor.set(agent, input.hostname);
        agents.push(agent);
        return agent;
      },
    ),
    fetch: ((target, init) => {
      const url = new URL(String(target));
      sent.push({
        hostname: url.hostname,
        pinnedFor: pinnedFor.get(init?.dispatcher as Agent),
      });
      return undiciFetch(target, init);
    }) as typeof undiciFetch,
  };
}

describe("a pool of pinned connections", () => {
  it("serves each hostname only from its own pinned connection, reused across reads and redirects", async () => {
    const pool = createPinnedPool();
    const dependencies = pooledDependencies();
    const before = connections;
    received = [];
    for (const url of [
      at("a.pool-test.com", "/feed"),
      at("b.pool-test.com", "/feed"),
      at("a.pool-test.com", "/feed"),
      at("a.pool-test.com", "/to-b"),
    ]) {
      // Each read follows the last, as a find's do once it has parsed the
      // response before.
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await expect(
        readFeedHttp(url, { pool }, dependencies),
      ).resolves.toMatchObject({ status: 200 });
    }
    pool.close();

    expect(dependencies.sent.map((request) => request.hostname)).toEqual([
      "a.pool-test.com",
      "b.pool-test.com",
      "a.pool-test.com",
      "a.pool-test.com",
      "b.pool-test.com",
    ]);
    for (const request of dependencies.sent)
      expect(request.pinnedFor).toBe(request.hostname);
    expect(received.map((headers) => headers.host)).toEqual(
      dependencies.sent.map(({ hostname }) => new URL(at(hostname, "/")).host),
    );
    // One resolution and one connection per hostname.
    expect(dependencies.resolveAddresses.mock.calls).toEqual([
      ["a.pool-test.com"],
      ["b.pool-test.com"],
    ]);
    expect(
      dependencies.createDispatcher.mock.calls.map(([input]) => input.hostname),
    ).toEqual(["a.pool-test.com", "b.pool-test.com"]);
    expect(connections - before).toBe(2);
  });

  it.each([
    "http://127.0.0.1/feed.xml",
    "http://10.1.2.3/feed.xml",
    "http://[::1]/feed.xml",
    "http://[::ffff:127.0.0.1]/feed.xml",
  ])("refuses a private or loopback target: %s", async (url) => {
    const pool = createPinnedPool();
    await expect(readFeedHttp(url, { pool })).rejects.toBeInstanceOf(
      BlockedOutboundTargetError,
    );
    pool.close();
  });

  it("checks a pooled hostname's addresses on every read until one connects", async () => {
    const pool = createPinnedPool();
    const dependencies = pooledDependencies(() =>
      Promise.resolve([{ address: "::ffff:192.168.1.1", family: 6 }]).then(
        validatePublicAddresses,
      ),
    );
    for (let read = 0; read < 2; read++)
      // oxlint-disable-next-line react-doctor/async-await-in-loop
      await expect(
        readFeedHttp(
          at("private.pool-test.com", "/feed"),
          { pool },
          dependencies,
        ),
      ).rejects.toThrow("not public");
    expect(dependencies.resolveAddresses).toHaveBeenCalledTimes(2);
    expect(dependencies.createDispatcher).not.toHaveBeenCalled();
    pool.close();
  });

  it("checks every redirect hop as a new target", async () => {
    const pool = createPinnedPool();
    const dependencies = pooledDependencies((hostname) =>
      Promise.resolve([
        {
          address:
            hostname === "private.pool-test.com"
              ? "169.254.169.254"
              : "127.0.0.1",
          family: 4,
        },
      ]).then((addresses) =>
        hostname === "private.pool-test.com"
          ? validatePublicAddresses(addresses)
          : addresses,
      ),
    );
    await expect(
      readFeedHttp(
        at("a.pool-test.com", "/to-blocked"),
        { pool },
        dependencies,
      ),
    ).rejects.toThrow("not allowed");
    await expect(
      readFeedHttp(
        at("a.pool-test.com", "/to-private"),
        { pool },
        dependencies,
      ),
    ).rejects.toThrow("not public");
    await expect(
      readFeedHttp(
        at("a.pool-test.com", "/redirect-a"),
        { pool, maxRedirects: 1 },
        dependencies,
      ),
    ).rejects.toThrow("Feed request exceeded 1 redirect");
    expect(dependencies.resolveAddresses).not.toHaveBeenCalledWith(
      "blocked.pool-test.com",
    );
    expect(
      dependencies.createDispatcher.mock.calls.map(([input]) => input.hostname),
    ).toEqual(["a.pool-test.com"]);
    pool.close();
  });

  it("ends its connections once the reads in flight finish, and lends none after closing", async () => {
    const pool = createPinnedPool();
    const dependencies = pooledDependencies();
    const started = new Promise<void>((resolve) => {
      onSlowChunk = resolve;
    });
    const reading = readFeedHttp(
      at("a.pool-test.com", "/slow"),
      { pool },
      dependencies,
    );
    await started;
    onSlowChunk = undefined;
    pool.close();
    const [pooled] = dependencies.agents;
    expect(pooled!.destroy).not.toHaveBeenCalled();
    await expect(reading).resolves.toMatchObject({ text: "<rss></rss>" });
    expect(pooled!.destroy).toHaveBeenCalled();

    // A read after closing connects on its own and closes its connection.
    await readFeedHttp(at("a.pool-test.com", "/feed"), { pool }, dependencies);
    const [, own] = dependencies.agents;
    expect(own).toBeDefined();
    expect(own!.close).toHaveBeenCalled();
    expect(dependencies.sent.at(-1)?.pinnedFor).toBe("a.pool-test.com");
  });
});

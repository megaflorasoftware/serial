import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MissingPublicRecordError,
  PublicRecordVersionUnavailableError,
} from "@serial/standard-site";
import { createPublicationClient } from "~/server/rss/atprotoClient";
import { discoverFeeds, streamDiscoverFeeds } from "~/server/feeds/discovery";
import { readFeedHttp } from "~/server/rss/feedHttp";
import {
  PublicationUnavailableError,
  resolvePublication,
} from "~/server/feeds/publications";

vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));
vi.mock("~/server/logger", () => ({ captureException: vi.fn() }));
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolve: vi.fn(),
  env: { ATPROTO_SLINGSHOT_ENDPOINT: "https://slingshot.microcosm.blue" },
}));
vi.mock("~/env", () => ({ env: mocks.env }));
vi.mock("~/server/auth/atproto/hardened-fetch", () => ({
  createHardenedFetch: () => mocks.fetch,
}));
vi.mock("~/server/auth/atproto/did-resolver", () => ({
  resolvePublicPds: vi.fn(),
}));
vi.mock("~/server/auth/atproto/identity", () => ({
  getAtprotoIdentityResolver: () => ({ resolve: mocks.resolve }),
}));
vi.mock("~/server/auth/atproto/typeahead", () => ({
  searchAtprotoActorsTypeahead: vi.fn(),
}));

const did = "did:plc:alice";
const uri = `at://${did}/site.standard.publication/site`;
const record = {
  uri,
  cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  value: { name: "Site", url: "https://site.example" },
};
const pds = "https://authoritative.example";
let sequence = 0;
let endpoint: string;
let resolvePds = vi.fn(() => Promise.resolve(pds));
const client = () =>
  createPublicationClient({ fetch: mocks.fetch, resolvePds });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  endpoint = `https://cache-${sequence++}.example`;
  mocks.env.ATPROTO_SLINGSHOT_ENDPOINT = endpoint;
  resolvePds = vi.fn(async () => pds);
  mocks.resolve.mockResolvedValue({
    did,
    didDoc: {
      id: did,
      service: [
        {
          id: `${did}#atproto_pds`,
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: pds,
        },
      ],
    },
  });
});
afterEach(() => vi.useRealTimers());

const callers = {
  discovery: () => resolvePublication(uri),
  conversion: () => client().getRecord(uri),
};
for (const [name, call] of Object.entries(callers)) {
  describe(name, () => {
    it("uses a valid Slingshot hit in one request", async () => {
      mocks.fetch.mockResolvedValue(Response.json(record));
      expect(await call()).toMatchObject(
        name === "discovery" ? { name: "Site" } : { value: { name: "Site" } },
      );
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(new URL(mocks.fetch.mock.calls[0]![0]).origin).toBe(endpoint);
      expect(resolvePds).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    });
    it.each([
      [
        "missing",
        () => Response.json({ error: "RecordNotFound" }, { status: 400 }),
      ],
      ["404", () => new Response(null, { status: 404 })],
      ["rate limit", () => new Response(null, { status: 429 })],
      ["server failure", () => new Response(null, { status: 503 })],
      ["wrong URI", () => Response.json({ ...record, uri: `${uri}wrong` })],
      ["wrong shape", () => Response.json({ ...record, value: {} })],
      [
        "wrong type",
        () =>
          Response.json({
            ...record,
            value: { ...record.value, $type: "wrong" },
          }),
      ],
      ["no CID", () => Response.json({ uri, value: record.value })],
      ["bad JSON", () => new Response("{")],
      [
        "network failure",
        () => {
          throw new Error("offline");
        },
      ],
    ])("falls back on %s", async (_name, response) => {
      mocks.fetch.mockImplementation(async (url: URL) =>
        url.origin === endpoint ? response() : Response.json(record),
      );
      expect(await call()).not.toBeNull();
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(new URL(mocks.fetch.mock.calls[1]![0]).origin).toBe(pds);
    });
    it("reserves fallback time when Slingshot stalls", async () => {
      const start = Date.now();
      mocks.fetch.mockImplementation(async (url: URL) =>
        url.origin === endpoint ? new Promise(() => {}) : Response.json(record),
      );
      const result = call();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).not.toBeNull();
      expect(Date.now() - start).toBe(1_000);
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(mocks.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    });
    it("propagates failure of both services for caller retry", async () => {
      mocks.fetch.mockImplementation(
        async () => new Response(null, { status: 503 }),
      );
      await expect(call()).rejects.toThrow("503");
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
  });
}

it.each([
  "https://slingshot.microcosm.blue",
  "https://custom.example/service/",
])(
  "selects configured/default service %s and still falls back",
  async (configured) => {
    mocks.env.ATPROTO_SLINGSHOT_ENDPOINT = configured;
    mocks.fetch.mockImplementation(async (url: URL) =>
      url.origin === pds
        ? Response.json(record)
        : new Response(null, { status: 503 }),
    );
    await client().getRecord(uri);
    const url = new URL(mocks.fetch.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe(
      configured.replace(/\/$/, "") + "/xrpc/com.atproto.repo.getRecord",
    );
    expect(new URL(mocks.fetch.mock.calls[1]![0]).origin).toBe(pds);
  },
);

it("preserves requested CID on fallback and isolates the latest-version cache", async () => {
  mocks.fetch.mockImplementation(async (url: URL) =>
    Response.json({
      ...record,
      cid:
        url.origin === pds
          ? url.searchParams.get("cid")!
          : "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai",
    }),
  );
  const remote = client();
  expect(await remote.getRecord(uri, { cid: record.cid })).toEqual(record);
  for (const [url] of mocks.fetch.mock.calls)
    expect(Object.fromEntries((url as URL).searchParams)).toEqual({
      repo: did,
      collection: "site.standard.publication",
      rkey: "site",
      cid: record.cid,
    });
  expect(await remote.getRecord(uri)).toMatchObject({
    cid: "bafyreiacaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcai",
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(3);
});
it("does not classify an unavailable CID as record deletion", async () => {
  mocks.fetch.mockImplementation(async () =>
    Response.json({ error: "RecordNotFound" }, { status: 400 }),
  );
  const error = await client()
    .getRecord(uri, {
      cid: "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae",
    })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(PublicRecordVersionUnavailableError);
  expect(error).not.toBeInstanceOf(MissingPublicRecordError);
});
it("rejects a wrong CID from both services", async () => {
  mocks.fetch.mockImplementation(async () => Response.json(record));
  await expect(
    client().getRecord(uri, {
      cid: "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae",
    }),
  ).rejects.toThrow("CID mismatch");
});
it("accepts supplied event records without identity or HTTP requests and validates them", async () => {
  const remote = client();
  expect(await remote.getRecord(uri, { cid: record.cid, record })).toEqual(
    record,
  );
  await expect(
    remote.getRecord(uri, {
      cid: "bafyreiabaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibaeaqcaibae",
      record,
    }),
  ).rejects.toThrow("CID mismatch");
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(resolvePds).not.toHaveBeenCalled();
});
it("reserves half of a nearly exhausted discovery budget for fallback", async () => {
  mocks.fetch.mockImplementation(async (url: URL) =>
    url.origin === endpoint ? new Promise(() => {}) : Response.json(record),
  );
  const result = resolvePublication(
    uri,
    new AbortController().signal,
    Date.now() + 200,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ name: "Site" });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
it("bounds stalled PDS resolution as part of the full lookup budget", async () => {
  mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
  resolvePds.mockReturnValue(new Promise(() => {}));
  const result = client()
    .getRecord(uri)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await result).toBeInstanceOf(Error);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("stops after caller cancellation without starting fallback", async () => {
  const controller = new AbortController();
  mocks.fetch.mockReturnValue(new Promise(() => {}));
  const result = client()
    .getRecord(uri, { signal: controller.signal })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(20);
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it.each(["seconds", "date"])(
  "honors Retry-After %s across client instances",
  async (form) => {
    mocks.fetch.mockImplementation(async (url: URL) =>
      url.origin === endpoint
        ? new Response(null, {
            status: 429,
            headers: {
              "Retry-After":
                form === "seconds"
                  ? "60"
                  : new Date(Date.now() + 60_000).toUTCString(),
            },
          })
        : Response.json(record),
    );
    await client().getRecord(uri);
    await client().getRecord(uri);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    await client().getRecord(uri);
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
  },
);

it.each([400, 401, 403, 410])(
  "retains discovery unavailability after authoritative HTTP %s",
  async (status) => {
    mocks.fetch.mockImplementation(async () => new Response(null, { status }));
    await expect(resolvePublication(uri)).rejects.toBeInstanceOf(
      PublicationUnavailableError,
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  },
);
it("rejects malformed CID values before accepting supplied records or making requests", async () => {
  mocks.fetch.mockImplementation(async () =>
    Response.json({ ...record, cid: "invalid" }),
  );
  await expect(client().getRecord(uri)).rejects.toThrow("CID mismatch");
  mocks.fetch.mockClear();
  await expect(client().getRecord(uri, { cid: "invalid" })).rejects.toThrow(
    "Invalid record identity",
  );
  await expect(
    client().getRecord(uri, { record: { ...record, cid: "invalid" } }),
  ).rejects.toThrow("CID mismatch");
  expect(mocks.fetch).not.toHaveBeenCalled();
});

function websiteResponse(url: string, text = "", ok = true) {
  return {
    url,
    text,
    ok,
    status: ok ? 200 : 404,
    statusText: "",
    headers: new Headers(),
  };
}
it.each(["healthy", "unavailable", "stalled"])(
  "keeps direct interactive discovery bounded with %s Slingshot",
  async (mode) => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) =>
      websiteResponse(url, "", false),
    );
    mocks.fetch.mockImplementation(async (url: URL) => {
      if (url.origin === endpoint && mode === "stalled")
        return new Promise(() => {});
      if (url.origin === endpoint && mode === "unavailable")
        return new Response(null, { status: 503 });
      return Response.json(record);
    });
    const start = Date.now();
    const result = discoverFeeds(`lookup-${sequence}`, uri);
    await vi.advanceTimersByTimeAsync(mode === "stalled" ? 1000 : 0);
    expect(await result).toMatchObject([
      { title: "Site", origins: [{ kind: "atproto", locator: uri }] },
    ]);
    expect(Date.now() - start).toBe(mode === "stalled" ? 1000 : 0);
    expect(mocks.fetch).toHaveBeenCalledTimes(mode === "healthy" ? 1 : 2);
    expect(mocks.resolve).toHaveBeenCalledTimes(mode === "healthy" ? 0 : 1);
  },
);
it("preserves a streamed RSS result and uses the remaining overall budget for Slingshot fallback", async () => {
  const site = "https://site.example/";
  const rss = `<rss version="2.0"><channel><title>Site</title><link>${site}</link><description>Site</description><item><title>Post</title><link>${site}post</link></item></channel></rss>`;
  vi.mocked(readFeedHttp).mockImplementation(async (url) => {
    if (url.includes("/.well-known/")) {
      await new Promise((resolve) => setTimeout(resolve, 4500));
      return websiteResponse(url, uri);
    }
    return websiteResponse(url, rss);
  });
  mocks.fetch.mockImplementation(async (url: URL) =>
    url.origin === endpoint ? new Promise(() => {}) : Response.json(record),
  );
  const start = Date.now();
  const events: Array<{ ms: number; complete: boolean; feeds: unknown[] }> = [];
  const result = (async () => {
    for await (const event of streamDiscoverFeeds(`stream-${sequence}`, site))
      events.push({ ...event, ms: Date.now() - start });
  })();
  await vi.advanceTimersByTimeAsync(5500);
  await result;
  expect(events.find((event) => event.feeds.length)?.ms).toBe(0);
  expect(events.at(-1)).toMatchObject({
    ms: 5500,
    complete: true,
    feeds: [{ origins: [{ kind: "rss" }, { kind: "atproto", locator: uri }] }],
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
});

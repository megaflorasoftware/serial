import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import {
  discoverFeedOriginsForImport,
  discoverFeedOriginsForRevalidation,
  discoverFeeds,
  streamDiscoverFeeds,
} from "~/server/feeds/discovery";
import {
  publicationRow,
  resolvePublication,
  searchPublications,
} from "~/server/feeds/publications";
import { captureLimiter } from "~/server/bookmarks/limits";
import { readFeedHttp } from "~/server/rss/feedHttp";

vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));
vi.mock("~/server/feeds/publications", () => ({
  resolvePublication: vi.fn().mockResolvedValue(null),
  searchPublications: vi.fn().mockResolvedValue([]),
  publicationRow: vi.fn(),
}));
vi.mock("~/server/logger", () => ({ captureException: vi.fn() }));

const site = "https://example.com/";
const rss = `${site}rss.xml`;
const xml =
  '<rss version="2.0"><channel><title>Example</title><link>https://example.com/</link><description>Example</description><item><title>Post</title><link>https://example.com/post</link><description>Body</description></item></channel></rss>';
type ResponseFixture = {
  ms: number;
  text?: string;
  status?: number;
  url?: string;
};

function responses(fixture: (url: string) => ResponseFixture) {
  vi.mocked(readFeedHttp).mockImplementation(async (url, options) => {
    const value = fixture(url);
    const budget = options?.totalDurationMs ?? 15000;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      const timer = setTimeout(
        () => {
          options?.signal?.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(value.ms, budget),
      );
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
    });
    if (value.ms > budget)
      throw new Error("Feed request exceeded its duration");
    const status = value.status ?? 200;
    return {
      url: value.url ?? url,
      text: value.text ?? "",
      status,
      ok: status >= 200 && status < 300,
      statusText: "",
      headers: new Headers(),
    };
  });
}

async function measure(operation: () => ReturnType<typeof discoverFeeds>) {
  const start = Date.now();
  let elapsedMs = 0;
  const pending = operation().then((rows) => {
    elapsedMs = Date.now() - start;
    return rows;
  });
  await vi.runAllTimersAsync();
  return { rows: await pending, elapsedMs };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it("returns a direct Feed within the optional hint budget", async () => {
  responses((url) =>
    url === rss ? { ms: 80, text: xml } : { ms: 5000, status: 404 },
  );
  const result = await measure(() => discoverFeeds("direct", rss));
  expect(result.rows.map((row) => row.url)).toEqual([rss]);
  expect(result.elapsedMs).toBeLessThanOrEqual(1000);
});

it("reaches a later RSS guess despite stalled earlier guesses within two seconds", async () => {
  responses((url) => {
    if (url === site) return { ms: 20, text: "<html></html>" };
    if (url === rss) return { ms: 80, text: xml };
    return { ms: 5000, status: 404 };
  });
  const result = await measure(() => discoverFeeds("guesses", site));
  expect(result.rows.map((row) => row.url)).toEqual([rss]);
  expect(result.elapsedMs).toBeLessThanOrEqual(2020);
  expect(readFeedHttp).toHaveBeenCalledTimes(10);
});

it("gives an advertised feed the primary allowance even at a guessed path", async () => {
  responses((url) => {
    if (url === site)
      return {
        ms: 20,
        text: '<link rel="alternate" type="application/rss+xml" href="/rss">',
      };
    if (url === `${site}rss`) return { ms: 4000, text: xml };
    return { ms: 20, status: 404 };
  });
  const result = await measure(() => discoverFeeds("advertised", site));
  expect(result.rows.map((row) => row.url)).toEqual([`${site}rss`]);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(4020);
  expect(result.elapsedMs).toBeLessThanOrEqual(4060);
  expect(
    vi.mocked(readFeedHttp).mock.calls.filter(([url]) => url === `${site}rss`),
  ).toHaveLength(1);
});

it("shares the hint allowance across a redirected origin", async () => {
  responses((url) => {
    if (url === rss)
      return { ms: 80, text: xml, url: "https://www.example.com/rss.xml" };
    if (url.startsWith("https://www.example.com/.well-known/"))
      return { ms: 900, status: 404 };
    if (url.includes("/.well-known/")) return { ms: 600, status: 404 };
    return { ms: 20, text: xml };
  });
  const result = await measure(() => discoverFeeds("redirected-hint", rss));
  expect(result.rows).toHaveLength(1);
  expect(result.elapsedMs).toBeLessThanOrEqual(1020);
  expect(readFeedHttp).toHaveBeenCalledWith(
    "https://www.example.com/.well-known/site.standard.publication",
    expect.objectContaining({ totalDurationMs: 400 }),
  );
});

it.each(["import", "revalidation"])(
  "retains the longer optional allowance for strict %s",
  async (mode) => {
    responses((url) =>
      url === rss ? { ms: 80, text: xml } : { ms: 1500, status: 404 },
    );
    const result = await measure(() =>
      mode === "import"
        ? discoverFeedOriginsForImport("strict", rss)
        : discoverFeedOriginsForRevalidation(rss),
    );
    expect(result.rows.map((row) => row.url)).toEqual([rss]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(1500);
  },
);

it.each(["import", "revalidation"])(
  "does not return successful RSS when strict %s has an incomplete Publication check",
  async (mode) => {
    responses((url) =>
      url === rss ? { ms: 80, text: xml } : { ms: 6000, status: 404 },
    );
    const pending = (
      mode === "import"
        ? discoverFeedOriginsForImport("strict-timeout", rss)
        : discoverFeedOriginsForRevalidation(rss)
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
  },
);

it("preserves alternate ranking and the candidate limit across both discovery phases", async () => {
  const atom =
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title><id>https://example.com/</id><updated>2026-09-16T00:00:00Z</updated><link href="https://example.com/"/><entry><id>https://example.com/post</id><title>Post</title><link href="https://example.com/post"/><updated>2026-09-16T00:00:00Z</updated><summary>Body</summary></entry></feed>';
  responses((url) => {
    if (url === site)
      return {
        ms: 20,
        text: '<link rel="alternate" type="application/rss+xml" href="/rss.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml">',
      };
    if (url === rss) return { ms: 20, text: xml };
    if (url === `${site}atom.xml`) return { ms: 1500, text: atom };
    return { ms: 20, status: 404 };
  });
  const result = await measure(() => discoverFeeds("alternates", site));
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    url: `${site}atom.xml`,
    origins: [{ kind: "rss", alternateUrls: [rss] }],
  });
  const calls = vi.mocked(readFeedHttp).mock.calls.map(([url]) => url);
  expect(calls).toHaveLength(10);
  expect(new Set(calls).size).toBe(10);
});

it("does not spend speculative capacity when eight advertised candidates already consumed it", async () => {
  responses((url) =>
    url === site
      ? {
          ms: 20,
          text: Array.from(
            { length: 8 },
            (_, i) =>
              `<link rel="alternate" type="application/rss+xml" href="/advertised-${i}">`,
          ).join(""),
        }
      : { ms: 20, status: 404 },
  );
  const result = await measure(() => discoverFeeds("all-advertised", site));
  expect(result.rows).toEqual([]);
  expect(readFeedHttp).toHaveBeenCalledTimes(10);
  expect(vi.mocked(readFeedHttp).mock.calls.some(([url]) => url === rss)).toBe(
    false,
  );
});

async function measureStream(query: string) {
  const start = Date.now();
  const events: Array<{
    ms: number;
    feeds: DiscoveredFeed[];
    complete: boolean;
  }> = [];
  const pending = (async () => {
    for await (const event of streamDiscoverFeeds(`stream-${query}`, query))
      events.push({ ...event, ms: Date.now() - start });
  })();
  await vi.runAllTimersAsync();
  await pending;
  return events;
}

it("streams RSS before a slow hint, then combines the late Atmosphere origin", async () => {
  const uri = "at://did:plc:example/site.standard.publication/one";
  vi.mocked(resolvePublication).mockResolvedValueOnce({
    uri,
    siteUrl: site,
    name: "Published name",
    did: "did:plc:example",
    rkey: "one",
    pdsUrl: "https://pds.example.com",
  });
  vi.mocked(publicationRow).mockReturnValueOnce({
    url: site,
    siteUrl: site,
    title: "Published name",
    origins: [{ kind: "atproto", locator: uri }],
  });
  responses((url) =>
    url === rss ? { ms: 80, text: xml } : { ms: 3000, text: uri },
  );
  const events = await measureStream(rss);
  const first = events.find((event) => event.feeds.length > 0)!;
  expect(first.ms).toBe(80);
  expect(first.complete).toBe(false);
  expect(first.feeds[0]?.url).toBe(rss);
  expect(
    first.feeds[0]?.origins?.some((origin) => origin.kind === "atproto"),
  ).not.toBe(true);
  expect(events.at(-1)).toMatchObject({
    complete: true,
    ms: 3000,
    feeds: [
      {
        title: "Published name",
        origins: [{ kind: "rss" }, { kind: "atproto", locator: uri }],
      },
    ],
  });
});

it("retains a slow guessed feed while faster guesses are already visible", async () => {
  responses((url) => {
    if (url === site) return { ms: 20, text: "<html></html>" };
    if (url === rss) return { ms: 2500, text: xml };
    if (url === `${site}feed`)
      return { ms: 80, text: xml.replaceAll("Example", "Separate") };
    return { ms: 5000, status: 404 };
  });
  const events = await measureStream(site);
  expect(events.find((event) => event.feeds.length)?.ms).toBeLessThanOrEqual(
    100,
  );
  expect(events.at(-1)?.feeds.map((feed) => feed.url)).toContain(rss);
  expect(events.at(-1)?.ms).toBeLessThanOrEqual(5020);
  expect(readFeedHttp).toHaveBeenCalledTimes(10);
});

it("stops at the overall deadline and preserves verified results when actor lookup stalls", async () => {
  vi.mocked(searchPublications).mockImplementationOnce(
    () => new Promise(() => {}),
  );
  responses((url) =>
    url === site ? { ms: 80, text: xml } : { ms: 10, status: 404 },
  );
  const events = await measureStream("example.com");
  expect(events.find((event) => event.feeds.length)?.ms).toBe(80);
  expect(events.at(-1)).toMatchObject({
    ms: 12000,
    complete: true,
    feeds: [{ url: site }],
  });
});

it("cancels obsolete reads and releases the discovery lease", async () => {
  const release = vi.fn();
  const acquire = vi
    .spyOn(captureLimiter, "acquire")
    .mockReturnValueOnce({ ok: true, release });
  responses((url) =>
    url === rss ? { ms: 80, text: xml } : { ms: 5000, status: 404 },
  );
  const controller = new AbortController();
  const events: unknown[] = [];
  const pending = (async () => {
    for await (const event of streamDiscoverFeeds(
      "cancel",
      rss,
      controller.signal,
    ))
      events.push(event);
  })();
  await vi.advanceTimersByTimeAsync(100);
  const count = events.length;
  controller.abort();
  await pending;
  expect(events).toHaveLength(count);
  expect(release).toHaveBeenCalledOnce();
  expect(
    vi
      .mocked(readFeedHttp)
      .mock.calls.every(([, options]) => options?.signal?.aborted),
  ).toBe(true);
  acquire.mockRestore();
});

it("assigns a shared site's RSS origin to only one of its Publications", async () => {
  const publications = ["one", "two"].map((rkey) => ({
    uri: `at://did:plc:example/site.standard.publication/${rkey}`,
    siteUrl: site,
    name: rkey,
    did: "did:plc:example",
    rkey,
    pdsUrl: "https://pds.example.com",
  }));
  vi.mocked(searchPublications).mockResolvedValueOnce(publications);
  vi.mocked(publicationRow).mockImplementation((publication) => ({
    url: site,
    siteUrl: site,
    title: publication.name,
    origins: [{ kind: "atproto", locator: publication.uri }],
  }));
  responses((url) =>
    url === site ? { ms: 80, text: xml } : { ms: 10, status: 404 },
  );
  const events = await measureStream("@example.com");
  const rows = events.at(-1)!.feeds;
  expect(rows).toHaveLength(2);
  expect(
    rows.filter((row) => row.origins?.some((origin) => origin.kind === "rss")),
  ).toHaveLength(1);
  expect(
    rows.map(
      (row) =>
        row.origins?.find((origin) => origin.kind === "atproto")?.locator,
    ),
  ).toEqual(publications.map((publication) => publication.uri));
});

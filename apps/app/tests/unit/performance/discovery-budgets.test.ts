import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  discoverFeedOriginsForImport,
  discoverFeedOriginsForRevalidation,
  discoverFeeds,
} from "~/server/feeds/discovery";
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
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(value.ms, budget)),
    );
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

import { discoverFeeds as scoutFeeds } from "feedscout";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverFeedOriginsForRevalidation,
  discoverFeeds,
} from "~/server/feeds/discovery";
import { readFeedHttp } from "~/server/rss/feedHttp";
import {
  resolvePublication,
  searchPublications,
} from "~/server/feeds/publications";

vi.mock("feedscout", () => ({ discoverFeeds: vi.fn().mockResolvedValue([]) }));
vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));
vi.mock("~/server/feeds/publications", () => ({
  resolvePublication: vi.fn(),
  searchPublications: vi.fn(),
  publicationRow: (publication: {
    siteUrl: string;
    uri: string;
    name: string;
  }) => ({
    url: publication.siteUrl,
    siteUrl: publication.siteUrl,
    title: publication.name,
    origins: [{ kind: "atproto", locator: publication.uri }],
  }),
}));
vi.mock("~/server/logger", () => ({ captureException: vi.fn() }));
const uri = "at://did:plc:example/site.standard.publication/one";
const publication = {
  uri,
  did: "did:plc:example",
  rkey: "one",
  pdsUrl: "https://pds.example.com",
  siteUrl: "https://www.example.com",
  name: "Example",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePublication).mockResolvedValue(publication);
  vi.mocked(searchPublications).mockResolvedValue([]);
});
function response(url: string, text: string, ok = true) {
  return {
    url,
    text,
    ok,
    status: ok ? 200 : 404,
    statusText: "",
    headers: new Headers(),
  };
}
function statusResponse(url: string, status: number) {
  return {
    ...response(url, "", status >= 200 && status < 300),
    status,
  };
}
describe("publication website discovery", () => {
  it.each(["link", "well-known"])(
    "discovers a subpath publication from the origin root through %s",
    async (method) => {
      vi.mocked(resolvePublication).mockResolvedValue({
        ...publication,
        siteUrl: "https://www.example.com/blog",
      });
      vi.mocked(readFeedHttp).mockImplementation(async (url) =>
        response(
          url,
          url.includes("/.well-known/")
            ? method === "well-known"
              ? uri
              : ""
            : method === "link"
              ? `<link rel="site.standard.publication" href="${uri}">`
              : "",
        ),
      );
      expect(
        await discoverFeeds("subpath-test", "https://www.example.com"),
      ).toHaveLength(1);
      expect(
        await discoverFeeds("sibling-test", "https://www.example.com/shop"),
      ).toEqual([]);
    },
  );
  it.each(["link", "well-known"])(
    "discovers a redirected website through %s",
    async (method) => {
      vi.mocked(readFeedHttp).mockImplementation(async (url) => {
        if (url === "https://example.com/")
          return response(
            "https://www.example.com/",
            method === "link"
              ? `<link rel="site.standard.publication" href="${uri}">`
              : "<html></html>",
          );
        if (
          url.startsWith("https://www.example.com/.well-known/") &&
          method === "well-known"
        )
          return response(url, uri);
        return response(url, "", false);
      });
      const rows = await discoverFeeds("redirect-test", "https://example.com");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.origins).toEqual([{ kind: "atproto", locator: uri }]);
      expect(readFeedHttp).toHaveBeenCalledWith(
        expect.stringContaining("https://www.example.com/.well-known/"),
        expect.objectContaining({
          maxBodyBytes: 1024 * 1024,
          totalDurationMs: expect.any(Number),
        }),
      );
    },
  );
  it("rejects a publication link whose record belongs to a different site", async () => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) =>
      response(url, `<link rel="site.standard.publication" href="${uri}">`),
    );
    expect(
      await discoverFeeds("wrong-site-test", "https://unrelated.com"),
    ).toEqual([]);
  });
  it("retains website results when account search fails", async () => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) =>
      response(url, `<link rel="site.standard.publication" href="${uri}">`),
    );
    vi.mocked(searchPublications).mockRejectedValue(new Error("unavailable"));
    expect(await discoverFeeds("joint-test", "www.example.com")).toHaveLength(
      1,
    );
  });
});

it("fails revalidation when an advertised publication cannot be read", async () => {
  vi.mocked(readFeedHttp).mockImplementation(async (url) =>
    response(url, url.includes("/.well-known/") ? uri : "<html></html>"),
  );
  vi.mocked(resolvePublication).mockRejectedValue(new Error("PDS unavailable"));
  await expect(
    discoverFeedOriginsForRevalidation("https://example.com/"),
  ).rejects.toThrow("PDS unavailable");
});
it("fails revalidation when the website cannot be read", async () => {
  vi.mocked(readFeedHttp).mockResolvedValue(
    response("https://example.com/", "", false),
  );
  await expect(
    discoverFeedOriginsForRevalidation("https://example.com/"),
  ).rejects.toThrow("Unable to read");
});
it.each([
  ["network", 0],
  ["rate limit", 429],
  ["server", 503],
] as const)(
  "fails revalidation when well-known publication discovery has a %s failure",
  async (failure, status) => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) => {
      if (url.includes("/.well-known/")) {
        if (failure === "network") throw new Error("well-known unavailable");
        return statusResponse(url, status);
      }
      return response(url, "<html></html>");
    });
    await expect(
      discoverFeedOriginsForRevalidation("https://example.com/"),
    ).rejects.toThrow(
      failure === "network" ? "well-known unavailable" : String(status),
    );
  },
);
it("allows an absent well-known publication during revalidation", async () => {
  vi.mocked(readFeedHttp).mockImplementation(async (url) =>
    url.includes("/.well-known/")
      ? statusResponse(url, 404)
      : response(url, "<html></html>"),
  );
  expect(
    await discoverFeedOriginsForRevalidation("https://example.com/"),
  ).toEqual([]);
});
it("fails when feedscout catches a failed advertised RSS request", async () => {
  const actual = await vi.importActual<{ discoverFeeds: typeof scoutFeeds }>(
    "feedscout",
  );
  vi.mocked(scoutFeeds).mockImplementationOnce(actual.discoverFeeds);
  vi.mocked(readFeedHttp).mockImplementation(async (url) => {
    if (url === "https://example.com/feed.xml")
      throw new Error("advertised RSS unavailable");
    if (url.includes("/.well-known/")) return statusResponse(url, 404);
    return response(
      url,
      '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
    );
  });
  await expect(
    discoverFeedOriginsForRevalidation("https://example.com/"),
  ).rejects.toThrow("advertised RSS unavailable");
});
it("fails when an advertised RSS request is rate limited", async () => {
  const actual = await vi.importActual<{ discoverFeeds: typeof scoutFeeds }>(
    "feedscout",
  );
  vi.mocked(scoutFeeds).mockImplementationOnce(actual.discoverFeeds);
  vi.mocked(readFeedHttp).mockImplementation(async (url) => {
    if (url === "https://example.com/feed.xml") return statusResponse(url, 429);
    if (url.includes("/.well-known/")) return statusResponse(url, 404);
    return response(
      url,
      '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
    );
  });
  await expect(
    discoverFeedOriginsForRevalidation("https://example.com/"),
  ).rejects.toThrow("429");
});
it("ignores failed speculative RSS guesses", async () => {
  vi.mocked(scoutFeeds).mockResolvedValueOnce([
    {
      url: "https://example.com/feed.xml",
      isValid: false,
      method: "guess",
      error: new Error("guess unavailable"),
    },
  ]);
  vi.mocked(readFeedHttp).mockImplementation(async (url) =>
    url.includes("/.well-known/")
      ? statusResponse(url, 404)
      : response(url, "<html></html>"),
  );
  expect(
    await discoverFeedOriginsForRevalidation("https://example.com/"),
  ).toEqual([]);
});
it("succeeds with no candidates when the website has no source links", async () => {
  vi.mocked(readFeedHttp).mockImplementation(async (url) =>
    response(url, "<html></html>"),
  );
  expect(
    await discoverFeedOriginsForRevalidation("https://example.com/"),
  ).toEqual([]);
});

it("caps discovery transport reads and publication candidates", async () => {
  vi.mocked(readFeedHttp).mockImplementation(async (url) =>
    response(
      url,
      url === "https://www.example.com/"
        ? Array.from(
            { length: 20 },
            (_, i) =>
              `<link rel="site.standard.publication" href="${uri}${i}">`,
          ).join("")
        : "",
    ),
  );
  vi.mocked(scoutFeeds).mockImplementationOnce(async (_url, options) => {
    await Promise.resolve();
    await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        options!.fetchFn!(`https://www.example.com/candidate-${i}`, {}),
      ),
    );
    return [];
  });
  await discoverFeedOriginsForRevalidation("https://www.example.com/");
  expect(readFeedHttp).toHaveBeenCalledTimes(24);
  expect(resolvePublication).toHaveBeenCalledTimes(4);
  for (const [, options] of vi.mocked(readFeedHttp).mock.calls) {
    expect(options?.maxBodyBytes).toBe(1024 * 1024);
    expect(options?.totalDurationMs).toBeLessThanOrEqual(5000);
  }
});

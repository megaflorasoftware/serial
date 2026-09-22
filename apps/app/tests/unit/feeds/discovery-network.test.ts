import { FEED_HTTP_MAX_BODY_BYTES } from "@serial/bookmark-capture";
import { discoverFeeds as scoutFeeds } from "feedscout";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverFeedOriginsForImport,
  discoverFeedOriginsForRevalidation,
  discoverFeeds,
} from "~/server/feeds/discovery";
import { captureLimiter } from "~/server/bookmarks/limits";
import { FeedImportDeferredError } from "~/server/feeds/importErrors";
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
  vi.mocked(scoutFeeds).mockResolvedValue([]);
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
          maxBodyBytes: FEED_HTTP_MAX_BODY_BYTES,
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
    expect(options?.maxBodyBytes).toBe(FEED_HTTP_MAX_BODY_BYTES);
    expect(options?.totalDurationMs).toBeLessThanOrEqual(5000);
  }
});

describe("advertised feed body size", () => {
  it("keeps an advertised feed larger than 1 MiB discoverable", async () => {
    const actual = await vi.importActual<{ discoverFeeds: typeof scoutFeeds }>(
      "feedscout",
    );
    vi.mocked(scoutFeeds).mockImplementation(actual.discoverFeeds);
    const feedUrl = "https://example.com/rss.xml";
    const feedBody = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Large</title><link href="https://example.com/"/>${Array.from(
      { length: 1200 },
      (_, index) =>
        `<entry><title>Post ${index}</title><link href="https://example.com/posts/${index}/"/><content>${"x".repeat(1024)}</content></entry>`,
    ).join("")}</feed>`;
    expect(feedBody.length).toBeGreaterThan(1024 * 1024);
    vi.mocked(readFeedHttp).mockImplementation(async (url, options) => {
      if (url === "https://example.com/posts/one/")
        return response(
          url,
          `<link rel="alternate" type="application/atom+xml" href="/rss.xml">`,
        );
      if (url === feedUrl) {
        const cap = options?.maxBodyBytes ?? FEED_HTTP_MAX_BODY_BYTES;
        if (feedBody.length > cap)
          throw new Error(`Feed response body exceeds ${cap} bytes`);
        return response(url, feedBody);
      }
      return statusResponse(url, 404);
    });
    const rows = await discoverFeeds(
      "large-feed",
      "https://example.com/posts/one/",
    );
    expect(rows.map((row) => row.url)).toEqual([feedUrl]);
    expect(rows[0]?.title).toBe("Large");
    vi.mocked(scoutFeeds).mockResolvedValue([]);
  });
});

describe("import discovery completeness", () => {
  it.each(["/feed.xml", "/feed.xml#rss"])(
    "keeps an invalid declared feed retryable after redirect: %s",
    async (href) => {
      const actual = await vi.importActual<{
        discoverFeeds: typeof scoutFeeds;
      }>("feedscout");
      vi.mocked(scoutFeeds).mockImplementationOnce(actual.discoverFeeds);
      vi.mocked(readFeedHttp).mockImplementation(async (url) => {
        if (url === "https://example.com/")
          return response(
            url,
            `<link rel="alternate" type="application/rss+xml" href="${href}">`,
          );
        if (url.startsWith("https://example.com/feed.xml"))
          return response("https://example.com/login", "<html>Sign in</html>");
        return statusResponse(url, 404);
      });
      await expect(
        discoverFeedOriginsForImport(
          `redirected-${href}`,
          "https://example.com/",
        ),
      ).rejects.toBeInstanceOf(FeedImportDeferredError);
    },
  );

  it("ignores a successfully read non-feed anchor beside an advertised RSS feed", async () => {
    const actual = await vi.importActual<{ discoverFeeds: typeof scoutFeeds }>(
      "feedscout",
    );
    vi.mocked(scoutFeeds).mockImplementationOnce(actual.discoverFeeds);
    vi.mocked(readFeedHttp).mockImplementation(async (url) => {
      if (url === "https://example.com/")
        return response(
          url,
          '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="https://reference.example/news">RSS Reader.</a>',
        );
      if (url === "https://example.com/feed.xml")
        return response(
          url,
          '<rss version="2.0"><channel><title>Example</title><link>https://example.com/</link><description>News</description><item><title>Post</title><link>https://example.com/post</link></item></channel></rss>',
        );
      if (url === "https://reference.example/news")
        return response(url, "<html><title>About RSS readers</title></html>");
      return statusResponse(url, 404);
    });
    const rows = await discoverFeedOriginsForImport(
      "non-feed-anchor",
      "https://example.com/",
    );
    expect(rows).toEqual([
      expect.objectContaining({ url: "https://example.com/feed.xml" }),
    ]);
  });

  it.each(["html", "headers"] as const)(
    "defers an unreadable advertised %s feed",
    async (method) => {
      vi.mocked(scoutFeeds).mockResolvedValue([
        { url: "https://example.com/rss", isValid: false, method },
      ]);
      vi.mocked(readFeedHttp).mockImplementation(async (url) =>
        response(
          url,
          '<link rel="alternate" type="application/rss+xml" href="/rss">',
        ),
      );
      await expect(
        discoverFeedOriginsForImport(
          `invalid-${method}`,
          "https://example.com",
        ),
      ).rejects.toBeInstanceOf(FeedImportDeferredError);
      expect(vi.mocked(scoutFeeds).mock.calls[0]?.[1]).toMatchObject({
        includeInvalid: true,
      });
    },
  );
  it("does not treat a discovered RSS origin disappearing as absence", async () => {
    vi.mocked(scoutFeeds).mockResolvedValue([
      { url: "https://example.com/rss", isValid: true, format: "rss" },
    ]);
    vi.mocked(readFeedHttp).mockImplementation(async (url) =>
      response(url, "<html></html>", url === "https://example.com"),
    );
    await expect(
      discoverFeedOriginsForImport("missing-rss", "https://example.com"),
    ).rejects.toBeInstanceOf(FeedImportDeferredError);
    await expect(
      discoverFeedOriginsForRevalidation("https://example.com"),
    ).rejects.toThrow("Unable to read the RSS Feed");
  });
  it("preserves the longest Retry-After across subsequent failures", async () => {
    vi.mocked(scoutFeeds).mockImplementation(async (_url, options) => {
      await options!.fetchFn!("https://example.com/slow");
      await options!.fetchFn!("https://example.com/offline");
      return [];
    });
    vi.mocked(readFeedHttp).mockImplementation(async (url) => {
      if (url.endsWith("/offline")) throw new Error("offline");
      if (url.endsWith("/slow"))
        return {
          ...response(url, "", false),
          status: 429,
          headers: new Headers({ "retry-after": "900" }),
        };
      return response(url, "<html></html>");
    });
    const before = Date.now();
    const error = await discoverFeedOriginsForImport(
      "multiple-failures",
      "https://example.com",
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FeedImportDeferredError);
    expect(
      (error as FeedImportDeferredError).retryAt.getTime(),
    ).toBeGreaterThanOrEqual(before + 900_000);
  });
  it("allows completed empty discovery when optional endpoints do not exist", async () => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) =>
      response(url, "<html></html>", !url.includes("/.well-known/")),
    );
    expect(
      await discoverFeedOriginsForImport(
        "complete-empty",
        "https://example.com",
      ),
    ).toEqual([]);
  });
  it("does not convert a blocked or unavailable site into empty discovery", async () => {
    vi.mocked(readFeedHttp).mockRejectedValue(new Error("Network timed out"));
    await expect(
      discoverFeedOriginsForImport("offline", "https://example.com"),
    ).rejects.toBeInstanceOf(FeedImportDeferredError);
  });
  it("propagates a discovery denial with a retry time", async () => {
    const acquire = vi
      .spyOn(captureLimiter, "acquire")
      .mockReturnValueOnce({ ok: false, reason: "rate_limited" });
    await expect(
      discoverFeedOriginsForImport("limited", "https://example.com"),
    ).rejects.toMatchObject({ retryAt: expect.any(Date) });
    acquire.mockRestore();
    expect(readFeedHttp).not.toHaveBeenCalled();
  });
  it("does not treat failure of the publication identity endpoint as absence", async () => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) =>
      url.includes("/.well-known/")
        ? { ...response(url, "", false), status: 503 }
        : response(url, "<html></html>"),
    );
    await expect(
      discoverFeedOriginsForImport("incomplete-hint", "https://example.com"),
    ).rejects.toBeInstanceOf(FeedImportDeferredError);
  });
  it("honors Retry-After when a server asks discovery to wait", async () => {
    vi.mocked(readFeedHttp).mockResolvedValue({
      ...response("https://example.com", "", false),
      status: 429,
      headers: new Headers({ "retry-after": "900" }),
    });
    const before = Date.now();
    try {
      await discoverFeedOriginsForImport("retry-after", "https://example.com");
      expect.unreachable();
    } catch (error) {
      expect(
        (error as FeedImportDeferredError).retryAt.getTime(),
      ).toBeGreaterThanOrEqual(before + 900_000);
    }
  });
});

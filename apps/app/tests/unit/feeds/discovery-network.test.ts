import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverFeeds } from "~/server/feeds/discovery";
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
describe("publication website discovery", () => {
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

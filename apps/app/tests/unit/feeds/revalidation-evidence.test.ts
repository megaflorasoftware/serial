import { beforeEach, expect, it, vi } from "vitest";
import type * as Publications from "~/server/feeds/publications";
import {
  originsShareArticles,
  readOriginEvidence,
} from "~/server/feeds/revalidationEvidence";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { resolvePublication } from "~/server/feeds/publications";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("~/server/rss/atprotoClient", () => ({
  createPublicationClient: () => ({ list }),
}));
vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));
vi.mock("~/server/feeds/publications", async (original) => ({
  ...(await original<typeof Publications>()),
  resolvePublication: vi.fn(),
}));
const did = "did:plc:example";
const uri = `at://${did}/site.standard.publication/site`;
const atmosphere = { kind: "atproto", locator: uri };
function document(path: string, site = uri, owner = did) {
  return {
    uri: `at://${owner}/site.standard.document/one`,
    cid: "cidone",
    value: {
      $type: "site.standard.document",
      title: "Full article",
      publishedAt: "2026-09-16T12:00:00Z",
      site,
      path,
      textContent: "Full text distinct from RSS excerpt",
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePublication).mockResolvedValue({
    uri,
    did,
    rkey: "site",
    siteUrl: "https://example.com",
    name: "Example",
    pdsUrl: "https://pds.example.com",
  });
  list.mockResolvedValue({ records: [document("/one")], cursor: undefined });
  vi.mocked(readFeedHttp).mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    url: "https://example.com/feed",
    text: JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "RSS",
      home_page_url: "https://example.com",
      items: [
        {
          id: "one",
          url: "https://example.com/one#section",
          content_text: "Excerpt",
        },
        { id: "two", url: "https://example.com/two", content_text: "Another" },
      ],
    }),
  });
});
it("matches canonical article URLs despite excerpts, fragments and different item counts", async () => {
  const rss = await readOriginEvidence({
    kind: "rss",
    locator: "https://example.com/feed",
  });
  const publication = await readOriginEvidence(atmosphere);
  expect(rss.itemUrls.size).toBe(2);
  expect(publication.itemUrls.size).toBe(1);
  expect(originsShareArticles(rss, publication)).toBe(true);
  expect(readFeedHttp).toHaveBeenCalledWith("https://example.com/feed", {
    maxBodyBytes: 1024 * 1024,
    totalDurationMs: 5000,
  });
});
it("ignores other publications, other repositories, invalid documents, and documents without paths", async () => {
  list.mockResolvedValue({
    records: [
      document("/other", `at://${did}/site.standard.publication/other`),
      document("/forged", uri, "did:plc:other"),
      document(""),
      {},
    ],
    cursor: undefined,
  });
  expect((await readOriginEvidence(atmosphere)).itemUrls.size).toBe(0);
});
it("accepts legacy publication references and stops after two pages", async () => {
  list.mockImplementation(async (_did, cursor) => ({
    records: [
      document(
        "/one",
        uri.replace("site.standard.publication", "pub.leaflet.publication"),
      ),
    ],
    cursor: cursor ? "next-again" : "next",
  }));
  expect((await readOriginEvidence(atmosphere)).itemUrls).toEqual(
    new Set(["https://example.com/one"]),
  );
  expect(list).toHaveBeenCalledTimes(2);
});
it("does not list documents for a metadata-only pass", async () => {
  await readOriginEvidence(atmosphere, false);
  expect(list).not.toHaveBeenCalled();
});
it("propagates source failures", async () => {
  list.mockRejectedValue(new Error("PDS unavailable"));
  await expect(readOriginEvidence(atmosphere)).rejects.toThrow(
    "PDS unavailable",
  );
});

it("preserves freshly verified alternate RSS locators for conflict checks", async () => {
  const alternateLocators = ["https://example.com/atom"];
  const result = await readOriginEvidence({
    kind: "rss",
    locator: "https://example.com/feed",
    alternateLocators,
  });
  expect(result.origin.alternateLocators).toEqual(alternateLocators);
});

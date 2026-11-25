import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Publications from "~/server/feeds/publications";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import {
  resolveFeedSelection,
  resolvePublicationFeed,
} from "~/server/feeds/resolveSelection";
import {
  discoverFeedOriginsForImport,
  discoverFeeds,
} from "~/server/feeds/discovery";
import { resolvePublication } from "~/server/feeds/publications";
import { PublicationGoneError } from "~/server/feeds/importErrors";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";
import { newRssFeedDetails } from "~/server/rss/types";

vi.mock("~/server/feeds/discovery", () => ({
  discoverFeeds: vi.fn(),
  discoverFeedOriginsForImport: vi.fn(),
}));
vi.mock("~/server/feeds/publications", async (original) => ({
  ...(await original<typeof Publications>()),
  resolvePublication: vi.fn(),
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
vi.mock("~/server/rss/fetchFeeds", () => ({ fetchNewFeedDetails: vi.fn() }));

const publicationUri =
  "at://did:plc:example/site.standard.publication/publication";
const publication = {
  uri: publicationUri,
  did: "did:plc:example",
  rkey: "publication",
  pdsUrl: "https://pds.example.com",
  siteUrl: "https://example.com/",
  name: "Example publication",
};
/** The reader import discovery hands back, holding the responses it read. */
const discoveryRead = vi.fn();
const selection = (rssUrl: string): DiscoveredFeed => ({
  url: rssUrl,
  siteUrl: publication.siteUrl,
  origins: [
    { kind: "rss", locator: rssUrl },
    { kind: "atproto", locator: publicationUri },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePublication).mockResolvedValue(publication);
  vi.mocked(discoverFeeds).mockResolvedValue([]);
  vi.mocked(discoverFeedOriginsForImport).mockResolvedValue({
    rows: [],
    read: discoveryRead,
  });
});

describe("resolving a selected publication", () => {
  it("rejects a comments Feed that shares the publication site", async () => {
    const rssUrl = "https://example.com/comments.xml";
    vi.mocked(fetchNewFeedDetails).mockResolvedValue([
      newRssFeedDetails({
        url: rssUrl,
        name: "Example comments",
        platform: "website",
        siteUrl: "https://example.com",
      }),
    ]);

    const combining = resolveFeedSelection(
      "user",
      publication.siteUrl,
      selection(rssUrl),
    );
    await expect(combining).rejects.toThrow(
      "The RSS Feed and publication cannot be combined",
    );
    // Trying again cannot change the answer, so an import stops here.
    await expect(combining).rejects.toBeInstanceOf(PublicationGoneError);
  });

  it("accepts a normal Feed matched to the publication site", async () => {
    const rssUrl = "https://example.com/feed.xml";
    vi.mocked(fetchNewFeedDetails).mockResolvedValue([
      newRssFeedDetails({
        url: rssUrl,
        name: "Example feed",
        platform: "website",
        siteUrl: "https://example.com?source=rss",
      }),
    ]);

    const [resolved] = await resolveFeedSelection(
      "user",
      publication.siteUrl,
      selection(rssUrl),
    );

    expect(resolved?.origins.map((origin) => origin.kind)).toEqual([
      "rss",
      "atproto",
    ]);
  });

  it("reuses Atmosphere discovery when it verifies RSS alternates", async () => {
    const rssUrl = "https://example.com/feed.xml";
    vi.mocked(discoverFeeds).mockResolvedValue([
      {
        url: rssUrl,
        title: "Example feed",
        siteUrl: publication.siteUrl,
        origins: [
          {
            kind: "rss",
            locator: rssUrl,
            alternateUrls: ["https://example.com/feed.json"],
          },
          { kind: "atproto", locator: publicationUri },
        ],
      },
    ]);
    vi.mocked(fetchNewFeedDetails).mockResolvedValue([
      newRssFeedDetails({
        url: rssUrl,
        name: "Example feed",
        platform: "website",
        siteUrl: publication.siteUrl,
      }),
    ]);

    const [resolved] = await resolveFeedSelection("user", publication.siteUrl, {
      url: publication.siteUrl,
      siteUrl: publication.siteUrl,
      origins: [{ kind: "atproto", locator: publicationUri }],
    });

    expect(discoverFeeds).toHaveBeenCalledOnce();
    expect(
      resolved?.origins.find((origin) => origin.kind === "rss")
        ?.alternateLocators,
    ).toEqual(["https://example.com/feed.json"]);
  });

  it("retains legacy URL-only Atmosphere discovery", async () => {
    vi.mocked(fetchNewFeedDetails).mockResolvedValue([]);
    vi.mocked(discoverFeeds).mockResolvedValue([
      {
        url: publication.siteUrl,
        siteUrl: publication.siteUrl,
        title: publication.name,
        origins: [{ kind: "atproto", locator: publicationUri }],
      },
    ]);

    const [resolved] = await resolveFeedSelection("user", publication.siteUrl);

    expect(resolved).toMatchObject({
      name: publication.name,
      origins: [{ kind: "atproto", locator: publicationUri }],
    });
  });
});

it("resolves a subscription URI once before discovering the publication's RSS origin", async () => {
  const [details] = await resolvePublicationFeed("user", publicationUri);
  expect(details?.origins).toEqual([
    expect.objectContaining({ kind: "atproto", locator: publicationUri }),
  ]);
  expect(resolvePublication).toHaveBeenCalledExactlyOnceWith(publicationUri);
  // Discovery reuses the record read above rather than reading it again.
  expect(discoverFeedOriginsForImport).toHaveBeenCalledExactlyOnceWith(
    "user",
    publication.siteUrl,
    publication,
  );
});

it("combines a known imported publication with RSS without requiring a website publication backlink", async () => {
  const rssUrl = "https://example.com/rss";
  vi.mocked(discoverFeedOriginsForImport).mockResolvedValue({
    rows: [
      {
        url: rssUrl,
        siteUrl: publication.siteUrl,
        origins: [{ kind: "rss", locator: rssUrl }],
      },
    ],
    read: discoveryRead,
  });
  vi.mocked(fetchNewFeedDetails).mockResolvedValue([
    newRssFeedDetails({
      name: "RSS",
      platform: "website",
      siteUrl: publication.siteUrl,
      url: rssUrl,
    }),
  ]);
  const [details] = await resolvePublicationFeed("user", publicationUri);
  expect(details?.origins.map((origin) => origin.kind)).toEqual([
    "rss",
    "atproto",
  ]);
  // The RSS Feed is read from the response discovery already holds.
  expect(fetchNewFeedDetails).toHaveBeenCalledExactlyOnceWith(
    rssUrl,
    discoveryRead,
  );
});
it("reports a record that does not describe the publication as gone", async () => {
  vi.mocked(resolvePublication).mockResolvedValue(null);
  await expect(
    resolvePublicationFeed("user", publicationUri),
  ).rejects.toBeInstanceOf(PublicationGoneError);
  expect(discoverFeedOriginsForImport).not.toHaveBeenCalled();
});
it("leaves an import unresolved when discovery cannot finish", async () => {
  vi.mocked(discoverFeedOriginsForImport).mockRejectedValue(
    new Error("Discovery throttled"),
  );
  await expect(resolvePublicationFeed("user", publicationUri)).rejects.toThrow(
    "Discovery throttled",
  );
});

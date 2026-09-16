import { describe, expect, it } from "vitest";
import {
  classifyDiscoveryInput,
  collapseSyndicationAlternates,
  combinePublicationRows,
  parseDiscoveredFeeds,
} from "@serial/feed-discovery";
import type {
  DiscoveredFeed,
  SyndicationCandidate,
} from "@serial/feed-discovery";

const rss = (format: string, full = true): SyndicationCandidate => ({
  row: {
    url: `https://example.com/${format}`,
    title: "Example",
    siteUrl: "https://example.com",
    format,
  },
  hasFullBody: full,
  itemUrls: ["https://example.com/post"],
});
const publication: DiscoveredFeed = {
  url: "https://example.com",
  siteUrl: "https://example.com/",
  title: "Publication",
  origins: [
    {
      kind: "atproto",
      locator: "at://did:plc:example/site.standard.publication/one",
    },
  ],
};

describe("publication discovery contracts", () => {
  it("searches both for bare domains and distinguishes explicit inputs", () => {
    expect(classifyDiscoveryInput("example.com")).toEqual({
      websiteUrl: "https://example.com/",
      actorQuery: "example.com",
    });
    expect(classifyDiscoveryInput("https://example.com")).toEqual({
      websiteUrl: "https://example.com/",
    });
    expect(classifyDiscoveryInput("@alice")).toEqual({ actorQuery: "alice" });
    expect(classifyDiscoveryInput("Alice Example")).toEqual({
      actorQuery: "Alice Example",
    });
    expect(
      classifyDiscoveryInput(
        "https://pdsls.dev/at://did:plc:example/site.standard.publication/one",
      ),
    ).toEqual({ publicationUri: publication.origins![0]!.locator });
    expect(
      classifyDiscoveryInput("https://user:secret@example.com"),
    ).toBeNull();
    expect(classifyDiscoveryInput("https://pdsls.dev/at://%ZZ")).toBeNull();
  });
  it("ranks Atom, JSON and RSS, choosing a full body over a body-less preferred format", () => {
    expect(
      collapseSyndicationAlternates([rss("rss"), rss("json"), rss("atom")])[0],
    ).toMatchObject({
      url: "https://example.com/atom",
      origins: [
        {
          alternateUrls: [
            "https://example.com/json",
            "https://example.com/rss",
          ],
        },
      ],
    });
    expect(
      collapseSyndicationAlternates([rss("atom", false), rss("json")])[0]
        ?.format,
    ).toBe("json");
    expect(
      collapseSyndicationAlternates(
        [rss("rss"), rss("atom")],
        "https://example.com/rss",
      )[0]?.format,
    ).toBe("rss");
  });
  it("keeps distinct sites and comment feeds separate", () => {
    const comment = rss("comments");
    const other = rss("atom");
    other.row.siteUrl = "https://different.com";
    expect(
      collapseSyndicationAlternates([rss("rss"), comment, other]),
    ).toHaveLength(3);
  });
  it("does not mistake a section Feed sharing one article for a format alternate", () => {
    const general = rss("rss");
    const section = rss("rss");
    section.row = {
      ...section.row,
      url: "https://example.com/essays.xml",
      title: "Essays",
    };
    expect(collapseSyndicationAlternates([general, section])).toHaveLength(2);
    section.row.format = "atom";
    expect(collapseSyndicationAlternates([general, section])).toHaveLength(2);
  });
  it("keeps website order, combines both origins once, then appends Atmosphere results", () => {
    const websites = collapseSyndicationAlternates([rss("atom")]);
    const other = {
      ...publication,
      url: "https://other.com",
      siteUrl: "https://other.com",
      origins: [
        {
          kind: "atproto" as const,
          locator: "at://did:plc:other/site.standard.publication/one",
        },
      ],
    };
    const result = combinePublicationRows(websites, [
      publication,
      other,
      publication,
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      url: websites[0]!.url,
      title: "Publication",
      origins: [{ kind: "rss" }, { kind: "atproto" }],
    });
    expect(result[1]).toEqual(other);
  });
  it("accepts legacy results but rejects duplicate kinds and hostile URLs", () => {
    expect(
      parseDiscoveredFeeds([{ url: "https://example.com/rss" }]),
    ).toHaveLength(1);
    expect(
      parseDiscoveredFeeds([
        {
          ...publication,
          origins: [publication.origins![0], publication.origins![0]],
        },
      ]),
    ).toBeNull();
    expect(parseDiscoveredFeeds([{ url: "javascript:alert(1)" }])).toBeNull();
  });
});

import { expect, it } from "vitest";
import { isDiscoveredFeedAdded } from "~/lib/feeds/origins";

const feeds = [
  {
    origins: [
      { kind: "rss" as const, locator: "https://example.com/rss.xml" },
      {
        kind: "atproto" as const,
        locator: "at://did:plc:example/site.standard.publication/one",
      },
    ],
  },
  { origins: [{ kind: "rss" as const, locator: "https://other.com/feed" }] },
];

it("matches a discovered RSS locator, an alternate locator, or a publication", () => {
  expect(
    isDiscoveredFeedAdded(feeds, { url: "https://example.com/rss.xml" }),
  ).toBe(true);
  expect(
    isDiscoveredFeedAdded(feeds, {
      url: "https://example.com/atom.xml",
      origins: [
        {
          kind: "rss",
          locator: "https://example.com/atom.xml",
          alternateUrls: ["https://example.com/rss.xml"],
        },
      ],
    }),
  ).toBe(true);
  expect(
    isDiscoveredFeedAdded(feeds, {
      url: "https://example.com/",
      origins: [
        {
          kind: "atproto",
          locator: "at://did:plc:example/site.standard.publication/one",
        },
      ],
    }),
  ).toBe(true);
});

it("leaves unrelated feeds and feeds without origins selectable", () => {
  expect(
    isDiscoveredFeedAdded(feeds, { url: "https://example.com/feed.json" }),
  ).toBe(false);
  expect(
    isDiscoveredFeedAdded([], { url: "https://example.com/rss.xml" }),
  ).toBe(false);
});

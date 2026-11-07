import { describe, expect, it } from "vitest";
import {
  getAtmosphereOrigin,
  getFeedPublicationName,
  getFeedWebsiteUrl,
} from "~/lib/feeds/origins";

const publication = {
  kind: "atproto" as const,
  locator: "at://did:plc:alice/site.standard.publication/blog",
  sourceName: "Published name",
};
const feed = {
  name: "My renamed Feed",
  platform: "website",
  siteUrl: "https://example.com/blog",
  origins: [publication],
};

describe("publication display", () => {
  it("keeps publication identity and observed name distinct from the website and renamed Feed", () => {
    expect(getAtmosphereOrigin(feed)?.locator).toBe(publication.locator);
    expect(getFeedPublicationName(feed)).toBe("Published name");
    expect(
      getFeedPublicationName({
        ...feed,
        origins: [{ ...publication, sourceName: null }],
      }),
    ).toBe(feed.name);
    expect(getFeedPublicationName({ ...feed, origins: [] })).toBeUndefined();
    expect(getFeedWebsiteUrl(feed)).toBe(feed.siteUrl);
  });

  it("preserves RSS website and YouTube channel destinations without accepting active URLs", () => {
    const rss = {
      kind: "rss" as const,
      locator: "https://example.com/feed.xml",
    };
    expect(getFeedWebsiteUrl({ ...feed, siteUrl: null, origins: [rss] })).toBe(
      "https://example.com",
    );
    expect(
      getFeedWebsiteUrl({
        ...feed,
        siteUrl: null,
        platform: "youtube",
        origins: [
          {
            ...rss,
            locator: "https://www.youtube.com/feeds/videos.xml?channel_id=abc",
          },
        ],
      }),
    ).toBe("https://www.youtube.com/channel/abc");
    expect(
      getFeedWebsiteUrl({ ...feed, siteUrl: "javascript:alert(1)" }),
    ).toBeUndefined();
  });
});

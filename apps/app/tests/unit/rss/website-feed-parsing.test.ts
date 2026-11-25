import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFetchableOrigin } from "./fetchable-origin";
import { fetchUnknownRssFeed } from "~/server/rss/parsers/unknown";
import { fetchWebsiteFeedData } from "~/server/rss/parsers/website";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { captureException, logError, logWarning } from "~/server/logger";

vi.mock("~/server/logger", () => ({
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));

const url = "https://example.pckt.blog/feed";
// Trimmed from a pckt.blog feed: no dc:creator, media:thumbnail or
// content:encoded, guids that are not links, and channel text in CDATA.
const pcktFeed = readFileSync(
  resolvePath(__dirname, "../../fixtures/pckt-feed.xml"),
  "utf8",
);

function serve(text: string) {
  vi.mocked(readFeedHttp).mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/xml; charset=utf-8" }),
    text,
    url,
  });
}

function expectNothingReported() {
  expect(logWarning).not.toHaveBeenCalled();
  expect(logError).not.toHaveBeenCalled();
  expect(captureException).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reading a feed of unknown platform", () => {
  it("reads a pckt feed as a website feed without logging the PeerTube check", async () => {
    serve(pcktFeed);
    expect(await fetchUnknownRssFeed(url)).toMatchObject({
      platform: "website",
      name: expect.stringContaining("art blog - pckt"),
      siteUrl: "https://example.pckt.blog/",
      origins: [
        {
          kind: "rss",
          locator: url,
          sourceDescription: "notes on paintings",
        },
      ],
    });
    expectNothingReported();
  });

  it("reads XML the stricter PeerTube parser rejects", async () => {
    serve(
      pcktFeed.replace(
        "<title>still life with pears</title>",
        "<title>salt & pepper</title>",
      ),
    );
    expect(await fetchUnknownRssFeed(url)).toMatchObject({
      platform: "website",
      siteUrl: "https://example.pckt.blog/",
    });
    expectNothingReported();
  });

  it("logs one line for a body that is not a feed and reports nothing", async () => {
    serve("<!doctype html><html><body>Not a feed</body></html>");
    expect(await fetchUnknownRssFeed(url)).toBeNull();
    expect(logWarning).toHaveBeenCalledExactlyOnceWith(
      `[feed-parse] ${url}: Unrecognized feed format`,
    );
    expect(logError).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("still reports an unexpected failure", async () => {
    const failure = new Error("socket hang up");
    vi.mocked(readFeedHttp).mockRejectedValue(failure);
    expect(await fetchUnknownRssFeed(url)).toBeNull();
    expect(captureException).toHaveBeenCalledWith(failure, {
      context: "unknown-feed-fetch",
      url,
    });
    expect(logWarning).not.toHaveBeenCalled();
  });
});

describe("refreshing a website feed", () => {
  const origin = () =>
    makeFetchableOrigin({ name: "Example", platform: "website", url });

  it("logs one line when the site stops serving a feed and reports nothing", async () => {
    serve("<!doctype html><html><body>Moved</body></html>");
    expect(await fetchWebsiteFeedData(origin())).toBeNull();
    expect(logWarning).toHaveBeenCalledExactlyOnceWith(
      `[feed-parse] ${url}: Unrecognized feed format`,
    );
    expect(logError).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reads the pckt feed's items, authors and cover images", async () => {
    serve(pcktFeed);
    const result = await fetchWebsiteFeedData(origin());
    expect(result).toMatchObject({
      items: [
        {
          id: "still-life-with-pears-a1b2c3d",
          url: "https://example.pckt.blog/still-life-with-pears-a1b2c3d",
          title: "still life with pears",
          author: "example's art blog",
          thumbnail:
            "https://pckt-blog-media.s3.us-east-2.amazonaws.com/cover_image/00000000-0000-4000-8000-000000000001/conversions/pears-feed_thumb.webp",
        },
        { id: "cant-stop-sketching-e4f5g6h", title: "can't stop sketching" },
      ],
    });
    expectNothingReported();
  });
});

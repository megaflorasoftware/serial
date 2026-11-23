import { describe, expect, it } from "vitest";
import type { RSSContent } from "~/server/rss/types";
import { parsedFeedDigest } from "~/server/rss/parsedFeedDigest";

const item = (overrides: Partial<RSSContent> = {}): RSSContent => ({
  id: "guid-1",
  url: "https://example.com/posts/1",
  title: "Post",
  author: "Author",
  publishedDate: "2026-09-15T12:00:00Z",
  content: "<p>Body</p>",
  contentSnippet: "Body",
  thumbnail: "https://example.com/cover.png",
  ...overrides,
});

const other = item({ id: "guid-2", url: "https://example.com/posts/2" });

describe.each(["text", "video"] as const)("a %s feed's digest", (medium) => {
  const digest = (items: RSSContent[]) => parsedFeedDigest(medium, items);

  it("is the same for the same parsed items", () => {
    expect(digest([item(), other])).toBe(digest([item(), other]));
  });

  it.each([
    ["id", { id: "guid-9" }],
    ["url", { url: "https://example.com/posts/9" }],
    ["title", { title: "Post, revised" }],
    ["author", { author: "Another author" }],
    ["content", { content: "<p>Body, revised</p>" }],
    ["contentSnippet", { contentSnippet: "Body, revised" }],
    ["thumbnail", { thumbnail: "https://example.com/other.png" }],
    ["publishedDate", { publishedDate: "2026-09-16T12:00:00Z" }],
  ] as const)("changes with an item's %s", (_field, change) => {
    expect(digest([item(change), other])).not.toBe(digest([item(), other]));
  });

  it("changes when an item is added, removed or moved", () => {
    const stated = digest([item(), other]);
    expect(digest([item()])).not.toBe(stated);
    expect(digest([item(), other, item({ id: "guid-3" })])).not.toBe(stated);
    expect(digest([other, item()])).not.toBe(stated);
  });

  it("ignores what its ingest does not read", () => {
    expect(
      digest([
        item({
          updatedDate: "2026-09-17T12:00:00Z",
          subtitle: "A subtitle",
          source: { title: "Source" },
        }),
      ]),
    ).toBe(digest([item()]));
  });

  it("keeps an undated item's digest from one fetch to the next", () => {
    const undated = item({ publishedDate: "" });
    expect(digest([undated])).toBe(digest([{ ...undated }]));
  });
});

it("tells a text feed from a video feed that states the same items", () => {
  expect(parsedFeedDigest("text", [item()])).not.toBe(
    parsedFeedDigest("video", [item()]),
  );
});

it("follows what only the text ingest reads", () => {
  for (const change of [
    { tags: ["news"] },
    { mediaThumbnail: "https://example.com/media.png" },
    { firstImageUrl: "https://example.com/first.png" },
  ]) {
    expect(parsedFeedDigest("text", [item(change)])).not.toBe(
      parsedFeedDigest("text", [item()]),
    );
    expect(parsedFeedDigest("video", [item(change)])).toBe(
      parsedFeedDigest("video", [item()]),
    );
  }
});

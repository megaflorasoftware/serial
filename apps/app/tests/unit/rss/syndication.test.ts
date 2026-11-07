import { describe, expect, it } from "vitest";
import { parseSyndicationFeed } from "~/server/rss/syndication";
import { composeItem, rssObservation } from "~/server/rss/itemObservation";

describe("syndication parser", () => {
  it.each(["thumbnail", "content"])(
    "retains explicit Atom media:%s ahead of body images",
    (kind) => {
      const parsed = parseSyndicationFeed(
        `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><id>site</id><title>Example</title><entry><id>post</id><link href="https://example.com/post"/><media:${kind} url="https://example.com/media.jpg" type="image/jpeg"/><content type="html">&lt;p&gt;Body&lt;/p&gt;&lt;img src="https://example.com/body.jpg"&gt;</content></entry></feed>`,
        "https://example.com/atom",
      );
      expect(parsed.items[0]).toMatchObject({
        thumbnail: "https://example.com/media.jpg",
        mediaThumbnail: "https://example.com/media.jpg",
        firstImageUrl: "https://example.com/body.jpg",
      });
    },
  );
  it("reads Atom authors, categories, enclosures, icon and updated date", () => {
    const result = parseSyndicationFeed(
      `<feed xmlns="http://www.w3.org/2005/Atom"><id>site</id><title>Example</title><icon>/icon.png</icon><link href="https://example.com"/><author><name>Feed author</name></author><entry><id>post</id><title>Post</title><link href="/post"/><link rel="enclosure" type="image/jpeg" href="/photo.jpg"/><updated>2026-09-15T00:00:00Z</updated><author><name>Alice</name></author><category term="garden"/><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>`,
      "https://example.com/atom",
    );
    expect(result).toMatchObject({
      format: "atom",
      imageUrl: "https://example.com/icon.png",
      hasFullBody: true,
    });
    expect(result.items[0]).toMatchObject({
      id: "post",
      author: "Alice",
      tags: ["garden"],
      thumbnail: "https://example.com/photo.jpg",
      mediaThumbnail: "https://example.com/photo.jpg",
      firstImageUrl: "",
      content: "<p>Body</p>",
      contentSnippet: "Body",
      updatedDate: "2026-09-15T00:00:00Z",
      publishedDate: "2026-09-15T00:00:00Z",
    });
  });
  it("reads JSON Feed and escapes plaintext content", () => {
    const result = parseSyndicationFeed(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Example",
        home_page_url: "https://example.com",
        icon: "https://example.com/icon.png",
        authors: [{ name: "Alice" }],
        items: [
          {
            id: "post",
            url: "https://example.com/post",
            content_text: "<script> & text",
            date_modified: "2026-09-15T00:00:00Z",
            tags: ["garden"],
          },
        ],
      }),
      "https://example.com/json",
    );
    expect(result.items[0]).toMatchObject({
      id: "post",
      author: "Alice",
      content: "&lt;script&gt; &amp; text",
      contentSnippet: "<script> & text",
      tags: ["garden"],
      updatedDate: "2026-09-15T00:00:00Z",
    });
  });
  it("retains RSS media, full content, categories and scheduling hints", () => {
    const result = parseSyndicationFeed(
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Example</title><link>https://example.com</link><description>Feed</description><ttl>30</ttl><item><guid>post</guid><title>Post</title><link>https://example.com/post</link><dc:creator>Alice</dc:creator><category>garden</category><content:encoded><![CDATA[<p>Body</p>]]></content:encoded><enclosure url="https://example.com/photo.jpg" type="image/jpeg" length="1"/></item></channel></rss>`,
      "https://example.com/rss",
    );
    expect(result.fetchMetadata.ttl).toBe(30);
    expect(result.items[0]).toMatchObject({
      author: "Alice",
      tags: ["garden"],
      content: "<p>Body</p>",
      thumbnail: "https://example.com/photo.jpg",
    });
  });
  it("decodes HTML excerpts into plain snippets without changing the body", () => {
    const result = parseSyndicationFeed(
      `<rss version="2.0"><channel><title>Example</title><link>https://example.com</link><description>Feed</description><item><guid>post</guid><link>https://example.com/post</link><description><![CDATA[<p>First &amp; second</p><p>Third &lt;literal&gt;</p>]]></description></item></channel></rss>`,
      "https://example.com/rss",
    );
    expect(result.items[0]?.contentSnippet).toMatch(
      /^First & second\s+Third <literal>$/,
    );
    expect(result.items[0]?.content).toContain("<p>First &amp; second</p>");
  });
  it.each([false, true])(
    "preserves composite thumbnail priority with RSS enclosure=%s",
    (enclosure) => {
      const parsed = parseSyndicationFeed(
        `<rss version="2.0"><channel><title>Example</title><link>https://example.com</link><description>Feed</description><item><guid>post</guid><link>https://example.com/post</link><description><![CDATA[<p>Body</p><img src="https://example.com/body.jpg">]]></description>${enclosure ? '<enclosure url="https://example.com/media.jpg" type="image/jpeg" length="1"/>' : ""}</item></channel></rss>`,
        "https://example.com/rss",
      );
      const rss = rssObservation(parsed.items[0]!);
      const document = {
        ...rss,
        kind: "atproto" as const,
        key: "at://did:plc:example/site.standard.document/post",
        thumbnail: "",
        firstImageUrl: "https://example.com/document.jpg",
      };
      expect(composeItem(rss, document).thumbnail).toBe(
        enclosure
          ? "https://example.com/media.jpg"
          : "https://example.com/document.jpg",
      );
    },
  );
});

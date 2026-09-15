import { describe, expect, it } from "vitest";
import {
  isBlockNativeDocument,
  parseDocumentRecord,
  parsePublicationRecord,
  parseSubscriptionRecord,
} from "../src/lexicons";
import { buildSubscriptionRecordKey } from "../src/subscription-key";
import {
  ARTICLE_SANITIZE_SCHEMA,
  sanitizeArticleHtml,
  sanitizeEmbeddedHtml,
} from "../src/sanitize";
import { codeBlock, image } from "../src/convert/html";
import {
  buildBlueskyCdnImageUrl,
  buildBlueskyPostUrl,
  buildBlueskyProfileUrl,
  buildCanonicalDocumentUrl,
  buildPdslsUrl,
  documentBelongsToPublication,
  isDid,
  isNsid,
  isRecordKey,
  normalizePublicationUrl,
  parseAtUri,
  parsePublicationUri,
} from "../src/uris";
import {
  FIXTURE_DOCUMENTS,
  loadDocumentFixture,
  readFixture,
} from "./fixtures";

describe("record parsers", () => {
  it("parses the sample publications", () => {
    const parsed = (readFixture("publications") as unknown[]).map(
      parsePublicationRecord,
    );
    expect(parsed.every((record) => record !== null)).toBe(true);
    expect(parsed.map((record) => record!.value.name)).toEqual([
      "ATProto Community",
      "Atmosphere Conference News",
      "Atmosphere Community",
      "jenn's little art blog",
    ]);
    expect(parsed[3]!.value.icon?.ref.$link).toBe(
      "bafkreigkcfkuvhf7wlwqgv4iachbwwkcxpmglf2fov6gf76jj6ub2vot2m",
    );
  });

  it("covers every document fixture with a publication fixture", () => {
    const publications = (readFixture("publications") as unknown[]).map(
      (entry) => parsePublicationRecord(entry)!,
    );
    for (const name of FIXTURE_DOCUMENTS) {
      const { record } = loadDocumentFixture(name);
      const owner = publications.find((publication) =>
        documentBelongsToPublication(record.value.site, publication.uri),
      );
      expect(owner, `${name} has no publication fixture`).toBeDefined();
    }
  });

  it.each(FIXTURE_DOCUMENTS)("parses %s as a block-native document", (name) => {
    const { record } = loadDocumentFixture(name);
    expect(record.value.site).toMatch(/^at:\/\//);
    expect(record.value.path?.startsWith("/")).toBe(true);
    expect(isBlockNativeDocument(record.value)).toBe(true);
  });

  it("rejects records missing required fields", () => {
    expect(
      parseDocumentRecord({
        uri: "at://did:plc:a/site.standard.document/b",
        cid: "c",
        value: { title: "x" },
      }),
    ).toBeNull();
    expect(
      parsePublicationRecord({
        uri: "u",
        cid: "c",
        value: { url: "https://a.test" },
      }),
    ).toBeNull();
    expect(
      parseSubscriptionRecord({ uri: "u", cid: "c", value: {} }),
    ).toBeNull();
    expect(parseSubscriptionRecord("nope")).toBeNull();
  });

  it("parses a subscription record", () => {
    const record = parseSubscriptionRecord({
      uri: "at://did:plc:lehcqqkwzcwvjvw66uthu5oq/site.standard.graph.subscription/3mmil3ylbwl2y",
      cid: "bafyreifbl7b4s5tp3iv2mfubi6gikhmtxqxixkxkrd4jrekzpsjhxv6hzm",
      value: {
        $type: "site.standard.graph.subscription",
        publication:
          "at://did:plc:lehcqqkwzcwvjvw66uthu5oq/site.standard.publication/3mjnpilwnrp2v",
      },
    });
    expect(record?.value.publication).toBe(
      "at://did:plc:lehcqqkwzcwvjvw66uthu5oq/site.standard.publication/3mjnpilwnrp2v",
    );
  });

  it("treats textContent-only documents as not block native", () => {
    const record = parseDocumentRecord({
      uri: "at://did:plc:a/site.standard.document/b",
      cid: "c",
      value: {
        site: "https://a.test",
        title: "Loose",
        publishedAt: "2026-01-01T00:00:00.000Z",
        textContent: "plain",
      },
    });
    expect(record).not.toBeNull();
    expect(isBlockNativeDocument(record!.value)).toBe(false);
  });
});

describe("uris", () => {
  it("parses at-uris", () => {
    expect(
      parseAtUri("at://did:plc:abc/site.standard.publication/3mjnpilwnrp2v"),
    ).toEqual({
      did: "did:plc:abc",
      collection: "site.standard.publication",
      rkey: "3mjnpilwnrp2v",
    });
    expect(parseAtUri("https://example.com")).toBeNull();
    expect(parseAtUri("at://did:plc:a/app.bsky.feed.post#frag/rk")).toBeNull();
    expect(parseAtUri("at://did:plc:a/app.bsky.feed.post/..")).toBeNull();
    expect(parseAtUri("at://did:plc:a/app.bsky.feed.post/a b")).toBeNull();
    expect(parseAtUri("at://jenn.pckt.blog/app.bsky.feed.post/3k")).toBeNull();
    expect(parseAtUri("at://did:plc:abc/com.foo/rk")).toBeNull();
    expect(parseAtUri("at://did:plc:abc/a.b.9x/rk")).toBeNull();
    expect(parseAtUri("at://did:plc:ab%zz/app.bsky.feed.post/rk")).toBeNull();
    expect(
      parseAtUri("at://did:web:example.com%3A3000/app.bsky.feed.post/rk"),
    ).toEqual({
      did: "did:web:example.com%3A3000",
      collection: "app.bsky.feed.post",
      rkey: "rk",
    });
    expect(
      parsePublicationUri("at://did:plc:abc/site.standard.document/x"),
    ).toBeNull();
  });

  it("matches a real legacy leaflet document to its publication", () => {
    const { record } = loadDocumentFixture("leaflet-legacy-site");
    const publications = readFixture("publications") as Array<{ uri: string }>;
    const conferenceNews = publications.find((entry) =>
      entry.uri.endsWith("/3m367bemk3c2i"),
    );
    expect(record.value.site).toBe(
      "at://did:plc:lehcqqkwzcwvjvw66uthu5oq/pub.leaflet.publication/3m367bemk3c2i",
    );
    expect(
      documentBelongsToPublication(record.value.site, conferenceNews!.uri),
    ).toBe(true);
  });

  it("accepts legacy leaflet publication sites for the same rkey", () => {
    const publication =
      "at://did:plc:abc/site.standard.publication/3m367bemk3c2i";
    expect(documentBelongsToPublication(publication, publication)).toBe(true);
    expect(documentBelongsToPublication("garbage", "garbage")).toBe(false);
    expect(
      documentBelongsToPublication(
        "at://did:plc:abc/pub.leaflet.publication/3m367bemk3c2i",
        publication,
      ),
    ).toBe(true);
    expect(
      documentBelongsToPublication(
        "at://did:plc:abc/pub.leaflet.publication/other",
        publication,
      ),
    ).toBe(false);
    expect(
      documentBelongsToPublication(
        "at://did:plc:zzz/pub.leaflet.publication/3m367bemk3c2i",
        publication,
      ),
    ).toBe(false);
  });

  it("builds canonical document urls", () => {
    expect(normalizePublicationUrl("https://news.atmosphereconf.org/")).toBe(
      "https://news.atmosphereconf.org",
    );
    expect(normalizePublicationUrl("news.atmosphereconf.org")).toBeNull();
    expect(normalizePublicationUrl("ftp://news.atmosphereconf.org")).toBeNull();
    expect(
      buildCanonicalDocumentUrl("news.atmosphereconf.org", "/post"),
    ).toBeNull();
    expect(
      buildCanonicalDocumentUrl(
        "https://news.atmosphereconf.org/",
        "/3m5pejic4fk2p",
      ),
    ).toBe("https://news.atmosphereconf.org/3m5pejic4fk2p");
    expect(
      buildCanonicalDocumentUrl("https://jenn.pckt.blog", "no-slash"),
    ).toBe("https://jenn.pckt.blog/no-slash");
    expect(
      buildCanonicalDocumentUrl("https://jenn.pckt.blog", undefined),
    ).toBeNull();
  });

  it("normalises the canonical url the way the rss side does", () => {
    const base = "https://a.test/blog";
    // Dot segments collapse, spaces and unicode percent-encode, the fragment goes.
    expect(buildCanonicalDocumentUrl(base, "/a/../b")).toBe(
      "https://a.test/blog/b",
    );
    // A path may climb out of the base directory but never off the origin.
    expect(buildCanonicalDocumentUrl(base, "/../../etc")).toBe(
      "https://a.test/etc",
    );
    expect(buildCanonicalDocumentUrl(base, "/a b")).toBe(
      "https://a.test/blog/a%20b",
    );
    expect(buildCanonicalDocumentUrl(base, "/héllo")).toBe(
      "https://a.test/blog/h%C3%A9llo",
    );
    expect(buildCanonicalDocumentUrl(base, "/p#f")).toBe(
      "https://a.test/blog/p",
    );
    // A document path may carry a query, and the rss side keeps one too.
    expect(buildCanonicalDocumentUrl(base, "/p?x=1")).toBe(
      "https://a.test/blog/p?x=1",
    );
    // Both sides keep trailing slashes and path case significant.
    expect(buildCanonicalDocumentUrl(base, "/post/")).toBe(
      "https://a.test/blog/post/",
    );
    expect(buildCanonicalDocumentUrl(base, "/Post")).toBe(
      "https://a.test/blog/Post",
    );
  });

  it("builds bluesky urls", () => {
    expect(buildBlueskyCdnImageUrl("did:plc:a", "bafy")).toBe(
      "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:a/bafy@jpeg",
    );
    expect(buildBlueskyPostUrl("at://did:plc:a/app.bsky.feed.post/3k")).toBe(
      "https://bsky.app/profile/did:plc:a/post/3k",
    );
    expect(
      buildBlueskyPostUrl("at://did:plc:a/site.standard.document/3k"),
    ).toBeNull();
  });

  it("refuses identifiers that cannot sit in a url path segment", () => {
    expect(buildBlueskyCdnImageUrl("did:plc:a", "../../evil")).toBeNull();
    expect(buildBlueskyCdnImageUrl("did:plc:a/..", "bafy")).toBeNull();
    expect(buildBlueskyCdnImageUrl("did:plc:a", "bafy@png")).toBeNull();
    expect(buildBlueskyProfileUrl("did:plc:abc")).toBe(
      "https://bsky.app/profile/did:plc:abc",
    );
    expect(buildBlueskyProfileUrl('did:plc:x" onclick="x()')).toBeNull();
    expect(buildBlueskyProfileUrl("did:plc:a/b")).toBeNull();
    expect(buildBlueskyProfileUrl("..")).toBeNull();
    expect(buildBlueskyProfileUrl("did:plc:abc%")).toBeNull();
    expect(buildPdslsUrl("../../evil")).toBeNull();
    expect(buildPdslsUrl("at://did:plc:a/site.standard.document/b")).toBe(
      "https://pdsls.dev/at://did:plc:a/site.standard.document/b",
    );
  });

  it("follows the at protocol identifier grammars", () => {
    expect(isDid("did:plc:lehcqqkwzcwvjvw66uthu5oq")).toBe(true);
    expect(isDid("did:web:example.com%3A3000")).toBe(true);
    expect(isDid("did:plc9:abc")).toBe(false);
    expect(isDid("did:PLC:abc")).toBe(false);
    expect(isDid("did:plc:")).toBe(false);
    expect(isNsid("site.standard.graph.subscription")).toBe(true);
    expect(isNsid("app.offprint.document.article")).toBe(true);
    expect(isNsid("a.b")).toBe(false);
    expect(isNsid("a.b.c-")).toBe(false);
    expect(isNsid(`a.b.${"c".repeat(64)}`)).toBe(false);
    expect(isRecordKey("3mjnpilwnrp2v")).toBe(true);
    expect(isRecordKey("..")).toBe(false);
  });
});

describe("subscription record key", () => {
  it("is the first 32 hex characters of sha-256 over the publication uri", async () => {
    await expect(
      buildSubscriptionRecordKey(
        "at://did:plc:lehcqqkwzcwvjvw66uthu5oq/site.standard.publication/3mjnpilwnrp2v",
      ),
    ).resolves.toBe("094e845fafa3cf5cbf51603a2a4da463");
  });
});

describe("article sanitizer", () => {
  it("keeps underline, highlight, figures, and known placeholders only", () => {
    const html =
      '<p><u>u</u><mark>m</mark></p><figure><img src="https://x/y.jpg" alt="a"><figcaption>c</figcaption></figure>' +
      '<div data-serial-embed="youtube" data-video-id="abc" data-start="5" data-other="x"><p>v</p></div>' +
      '<div data-serial-embed="evil" data-href="https://a">t</div><iframe src="https://x"></iframe><script>x()</script>';
    expect(sanitizeArticleHtml(html)).toBe(
      '<p><u>u</u><mark>m</mark></p><figure><img src="https://x/y.jpg" alt="a"><figcaption>c</figcaption></figure>' +
        '<div data-serial-embed="youtube" data-video-id="abc" data-start="5"><p>v</p></div>' +
        '<div data-href="https://a">t</div>',
    );
  });

  it("still prefixes ids like the default schema", () => {
    expect(sanitizeArticleHtml('<p id="x">t</p>')).toBe(
      '<p id="user-content-x">t</p>',
    );
    expect(ARTICLE_SANITIZE_SCHEMA.clobberPrefix).toBe("user-content-");
  });

  it("escapes backticks and drops nulls so emissions stay fixed points", () => {
    const withBacktick = image("https://x.test/a.png", "a`b");
    expect(withBacktick).toBe(
      '<img src="https://x.test/a.png" alt="a&#x60;b">',
    );
    expect(sanitizeArticleHtml(withBacktick)).toBe(withBacktick);

    const withNulls =
      codeBlock("a\u0000b", "js") + image("https://x.test/a.png", "c\u0000d");
    expect(withNulls).not.toContain("\u0000");
    expect(sanitizeArticleHtml(withNulls)).toBe(withNulls);
  });

  it("strips clobbered attributes from embedded html so the result stays a fixed point", () => {
    const embedded = sanitizeEmbeddedHtml(
      '<p id="x" name="n" aria-label="l" title="t">t</p><a href="#x">j</a>',
    );
    expect(embedded).toBe('<p title="t">t</p><a href="#x">j</a>');
    expect(sanitizeArticleHtml(embedded)).toBe(embedded);
  });
});

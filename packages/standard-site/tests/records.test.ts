import { describe, expect, it } from "vitest";
import {
  isBlockNativeDocument,
  parseDocumentRecord,
  parsePublicationRecord,
  parseSubscriptionRecord,
} from "../src/lexicons";
import { buildSubscriptionRecordKey } from "../src/subscription-key";
import { ARTICLE_SANITIZE_SCHEMA, sanitizeArticleHtml } from "../src/sanitize";
import {
  buildBlueskyCdnImageUrl,
  buildBlueskyPostUrl,
  buildCanonicalDocumentUrl,
  documentBelongsToPublication,
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
  it("parses the three sample publications", () => {
    const listed = readFixture("publications") as unknown[];
    const parsed = listed.map(parsePublicationRecord);
    expect(parsed.every((record) => record !== null)).toBe(true);
    expect(parsed.map((record) => record!.value.name)).toEqual([
      "Atmosphere Conference News",
      "Atmosphere Community",
      "jenn's little art blog",
    ]);
    expect(parsed[2]!.value.icon?.ref.$link).toBe(
      "bafkreigkcfkuvhf7wlwqgv4iachbwwkcxpmglf2fov6gf76jj6ub2vot2m",
    );
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
    expect(
      parsePublicationUri("at://did:plc:abc/site.standard.document/x"),
    ).toBeNull();
  });

  it("accepts legacy leaflet publication sites for the same rkey", () => {
    const publication =
      "at://did:plc:abc/site.standard.publication/3m367bemk3c2i";
    expect(documentBelongsToPublication(publication, publication)).toBe(true);
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
});

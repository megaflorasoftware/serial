import { describe, expect, it, vi } from "vitest";
import {
  parseRecordCard,
  recordCard,
  recordPreview,
  sanitizeArticleHtml,
} from "../src";
import { renderRichText } from "../src/convert/facets";

const did = "did:plc:author";
const site = `at://did:plc:publisher/site.standard.publication/site`;
const uri = `at://${did}/site.standard.document/post`;
const blob = { ref: { $link: "bafyimage" }, mimeType: "image/jpeg" };
const record = {
  uri,
  cid: "bafy",
  value: {
    site,
    title: "Title",
    description: "Summary",
    path: "/post",
    publishedAt: "2026-09-18T00:00:00Z",
    coverImage: blob,
    contributors: [{ did, displayName: "Author" }],
  },
};
const publication = {
  uri: site,
  cid: "bafy",
  value: { name: "Publication", url: "https://example.com", icon: blob },
};

describe("record previews", () => {
  it("derives complete document metadata and uses each blob's owning repository", () => {
    const read = vi.fn((target: string) =>
      target === uri ? record : publication,
    );
    const preview = recordPreview(uri, read);
    expect(preview).toMatchObject({
      url: "https://example.com/post",
      title: "Title",
      description: "Summary",
      publicationName: "Publication",
      author: "Author",
      publishedAt: "2026-09-18T00:00:00Z",
    });
    expect(preview?.imageUrl).toContain("/did:plc:author/");
    expect(preview?.iconUrl).toContain("/did:plc:publisher/");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("opens documents with direct website URLs without a publication lookup", () => {
    const read = vi.fn(() => ({
      ...record,
      value: { ...record.value, site: "https://example.com" },
    }));
    expect(recordPreview(uri, read)).toMatchObject({
      url: "https://example.com/post",
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(uri);
  });
  it("keeps document metadata when its publication is unavailable", () => {
    const preview = recordPreview(uri, (target) =>
      target === uri ? record : undefined,
    );
    expect(preview).toMatchObject({
      title: "Title",
      description: "Summary",
      url: `https://pdsls.dev/${uri}`,
    });
  });
  it("keeps publication descriptions and icons", () => {
    expect(recordPreview(site, () => publication)).toMatchObject({
      title: "Publication",
      url: "https://example.com",
      iconUrl: expect.stringContaining("/avatar/"),
    });
  });
  it("accepts arbitrary record collections without guessing their metadata", () => {
    const target = `at://${did}/blog.pckt.note/note`;
    const read = vi.fn(() => ({
      uri: target,
      cid: "bafy",
      value: { $type: "blog.pckt.note", title: "Not a standard document" },
    }));
    expect(recordPreview(target, read)).toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith(target);
  });
  it("does not look up malformed URIs", () => {
    const read = vi.fn();
    expect(recordPreview("javascript:alert(1)", read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

it("round-trips typed cards and rejects unsafe attributes at the reader boundary", () => {
  const html = recordCard(
    {
      uri,
      url: "https://example.com",
      title: '<script>"Title"</script>',
      imageUrl: "javascript:alert(1)",
    },
    "large",
  );
  expect(sanitizeArticleHtml(html)).toBe(html);
  expect(html).not.toContain("javascript:");
  expect(html).toContain('<strong>&#x3C;script>"Title"&#x3C;/script></strong>');
  expect(
    parseRecordCard({
      "data-record-uri": uri,
      "data-href": "javascript:alert(1)",
      "data-title": "Title",
    }),
  ).toBeNull();
  expect(
    parseRecordCard({
      "data-record-uri": uri,
      "data-href": "https://example.com",
      "data-title": "Title",
      "data-image-url": "data:image/svg+xml,bad",
      "data-size": "giant",
    }),
  ).toMatchObject({ size: "row", imageUrl: undefined });
});

it("uses safe authored mention destinations or the record inspector when lookup fails", () => {
  const mention = (href?: string) =>
    renderRichText({
      plaintext: "Name",
      facets: [
        {
          index: { byteStart: 0, byteEnd: 4 },
          features: [
            { $type: "pub.leaflet.richtext.facet#atMention", atURI: uri, href },
          ],
        },
      ],
    });
  expect(mention("https://example.com/post")).toBe(
    `<a href="https://example.com/post" data-record-uri="${uri}">Name</a>`,
  );
  expect(mention("javascript:alert(1)")).toBe(
    `<a href="https://pdsls.dev/${uri}" data-record-uri="${uri}">Name</a>`,
  );
});

import { describe, expect, it } from "vitest";
import {
  convertDocumentContent,
  discoverReferences,
  referencedPublications,
} from "../src";
import type { RecordLookup } from "../src";

const did = "did:plc:alice";
const uri = `at://${did}/site.standard.document/article`;
const site = `at://did:plc:publisher/site.standard.publication/site`;
const card = (uri: string): Record<string, unknown> => ({
  $type: "pub.leaflet.blocks.standardSitePost",
  uri,
});
function document(uris: string[]) {
  return {
    content: {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: uris.map((uri) => ({
            block: card(uri),
          })),
        },
      ],
    },
  };
}
function documentRecord(target: string, value: Record<string, unknown> = {}) {
  return {
    uri: target,
    cid: "bafy",
    value: {
      site: "https://example.com",
      title: "An article",
      path: "/article",
      publishedAt: "2026-09-18T00:00:00Z",
      ...value,
    },
  };
}
function lookup(records: Record<string, unknown>): RecordLookup {
  return (target) => records[target];
}

describe("embedded standard.site records", () => {
  it("renders resolved records as canonical cards", async () => {
    const result = await convertDocumentContent(document([uri, uri]), {
      did,
      loadBlob: () => Promise.reject(new Error("no blobs")),
      records: lookup({ [uri]: documentRecord(uri) }),
    });
    expect(result?.html).toContain('href="https://example.com/article"');
    expect(result?.html).toContain("An article");
  });
  it("retains the existing link card when a reference is unresolved", async () => {
    const result = await convertDocumentContent(document([uri]), {
      did,
      loadBlob: () => Promise.reject(new Error("no blobs")),
    });
    expect(result?.html).toContain(`https://pdsls.dev/${uri}`);
    expect(result?.html).toContain('data-size="row"');
  });
  it("discovers distinct rendered references, capped at sixteen", () => {
    const many = Array.from({ length: 100 }, (_, i) => `${uri}${i}`);
    expect(discoverReferences(document(many).content, did)).toHaveLength(16);
    expect(discoverReferences(document([uri, uri]).content, did)).toEqual([
      uri,
    ]);
  });

  it("discovers only cards emitted from linear pages", () => {
    const visible = `${uri}-visible`;
    const decoy = `${uri}-decoy`;
    const input = document([visible]);
    input.content.pages.unshift({
      $type: "pub.leaflet.pages.canvas",
      blocks: Array.from({ length: 16 }, (_, index) => ({
        block: card(`${decoy}-canvas-${index}`),
      })),
    });
    Object.assign(input.content, {
      unknown: Array.from({ length: 16 }, (_, index) =>
        card(`${decoy}-unknown-${index}`),
      ),
    });
    input.content.pages[1]!.blocks.unshift({
      block: {
        $type: "pub.leaflet.blocks.unorderedList",
        children: Array.from({ length: 16 }, (_, index) => ({
          content: card(`${decoy}-list-${index}`),
        })),
      },
    });
    expect(discoverReferences(input.content, did)).toEqual([visible]);
  });

  it("names the publications of referenced documents", () => {
    const records = lookup({
      [uri]: documentRecord(uri, { site }),
      [`${uri}-direct`]: documentRecord(`${uri}-direct`),
    });
    expect(referencedPublications([uri, `${uri}-direct`], records)).toEqual([
      site,
    ]);
    expect(referencedPublications([uri, site], records)).toEqual([]);
  });

  it("renders publication names from their snapshots", async () => {
    const result = await convertDocumentContent(document([uri]), {
      did,
      loadBlob: () => Promise.reject(new Error("no blobs")),
      records: lookup({
        [uri]: documentRecord(uri, { site }),
        [site]: {
          uri: site,
          cid: "bafy",
          value: { name: "Publication", url: "https://pub.example.com" },
        },
      }),
    });
    expect(result?.html).toContain('data-publication-name="Publication"');
    expect(result?.html).toContain('href="https://pub.example.com/article"');
  });
});

it.each(["small", "medium", "large", undefined, "invalid"])(
  "preserves size %s through sanitization",
  async (size) => {
    const input = document([uri]);
    input.content.pages[0]!.blocks[0]!.block.size = size;
    const result = await convertDocumentContent(input, {
      did,
      loadBlob: () => Promise.reject(new Error("no blobs")),
      records: lookup({
        [uri]: documentRecord(uri, {
          title: "A <title>",
          description: "Summary",
          coverImage: { ref: { $link: "bafycover" }, mimeType: "image/jpeg" },
        }),
      }),
    });
    expect(result?.html).toContain(
      `data-size="${size && size !== "invalid" ? size : "row"}"`,
    );
    expect(result?.html).toContain('data-image-url="https://cdn.bsky.app/');
    expect(result?.html).toContain("<strong>A &#x3C;title></strong>");
  },
);

it.each(["pub.leaflet", "blog.pckt"])(
  "resolves %s AT mentions and preserves UTF-8 text",
  async (prefix) => {
    const text = {
      $type: `${prefix === "pub.leaflet" ? "pub.leaflet.blocks" : "blog.pckt.block"}.text`,
      plaintext: "🌿 Field Notes!",
      facets: [
        {
          index: { byteStart: 5, byteEnd: 16 },
          features: [
            { $type: `${prefix}.richtext.facet#atMention`, atURI: uri },
          ],
        },
      ],
    };
    const content =
      prefix === "pub.leaflet"
        ? {
            $type: "pub.leaflet.content",
            pages: [
              {
                $type: "pub.leaflet.pages.linearDocument",
                blocks: [{ block: text }, { block: card(uri) }],
              },
            ],
          }
        : {
            $type: "blog.pckt.content",
            items: [
              text,
              {
                $type: "blog.pckt.block.noteEmbed",
                noteRef: { uri, cid: "bafy" },
              },
            ],
          };
    expect(discoverReferences(content, did)).toEqual([uri]);
    const result = await convertDocumentContent(
      { content },
      {
        did,
        loadBlob: () => Promise.reject(new Error("no blobs")),
        records: lookup({
          [uri]: documentRecord(uri, { path: "/notes", title: "Replacement" }),
        }),
      },
    );
    expect(result?.html).toContain(
      `🌿 <a href="https://example.com/notes" data-record-uri="${uri}">Field Notes</a>!`,
    );
    expect(result?.html).toContain('data-serial-embed="record"');
  },
);

it("discovers mentions inside nested lists and footnotes but not empty byte ranges", () => {
  const mention = (target: string) => ({
    index: { byteStart: 0, byteEnd: 4 },
    features: [
      { $type: "pub.leaflet.richtext.facet#atMention", atURI: target },
    ],
  });
  const footnoteUri = `${uri}-footnote`;
  const content = {
    $type: "pub.leaflet.content",
    pages: [
      {
        $type: "pub.leaflet.pages.linearDocument",
        blocks: [
          {
            block: {
              $type: "pub.leaflet.blocks.unorderedList",
              children: [
                {
                  content: {
                    $type: "pub.leaflet.blocks.text",
                    plaintext: "Link",
                    facets: [mention(uri)],
                  },
                },
              ],
            },
          },
          {
            block: {
              $type: "pub.leaflet.blocks.text",
              plaintext: "Note",
              facets: [
                {
                  index: { byteStart: 0, byteEnd: 4 },
                  features: [
                    {
                      $type: "pub.leaflet.richtext.facet#footnote",
                      contentPlaintext: "Link",
                      contentFacets: [mention(footnoteUri)],
                    },
                  ],
                },
                {
                  ...mention(`${uri}-hidden`),
                  index: { byteStart: 0, byteEnd: 0 },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  expect(discoverReferences(content, did)).toEqual([uri, footnoteUri]);
});

it("keeps a generic row when required preview metadata is invalid", async () => {
  const result = await convertDocumentContent(document([uri]), {
    did,
    loadBlob: () => Promise.reject(new Error("no blobs")),
    records: lookup({
      [uri]: documentRecord(uri, { title: "x".repeat(10_001) }),
    }),
  });
  expect(result?.html).toContain('data-size="row"');
  expect(result?.html).toContain(`href="https://pdsls.dev/${uri}"`);
});

it("drops oversized optional metadata without dropping the card", async () => {
  const result = await convertDocumentContent(document([uri]), {
    did,
    loadBlob: () => Promise.reject(new Error("no blobs")),
    records: lookup({
      [uri]: documentRecord(uri, {
        title: "Title",
        description: "x".repeat(10_001),
      }),
    }),
  });
  expect(result?.html).toContain('data-title="Title"');
  expect(result?.html).not.toContain("data-description=");
});

it("renders pckt galleries from their referenced record", async () => {
  const gallery = `${did.replace("alice", "bob")}/blog.pckt.gallery/one`;
  const galleryUri = `at://${gallery}`;
  const result = await convertDocumentContent(
    {
      content: {
        $type: "blog.pckt.content",
        items: [{ $type: "blog.pckt.block.gallery", ref: galleryUri }],
      },
    },
    {
      did,
      loadBlob: () => Promise.reject(new Error("no blobs")),
      records: lookup({
        [galleryUri]: {
          uri: galleryUri,
          cid: "bafy",
          value: {
            images: [
              { src: "blob:bafyone", alt: "One" },
              { src: "https://example.com/two.png" },
            ],
            caption: "Two <pictures>",
          },
        },
      }),
    },
  );
  expect(result?.html).toMatch(
    /^<figure><img src="https:\/\/cdn\.bsky\.app\/[^"]+" alt="One"><img src="https:\/\/example\.com\/two\.png" alt=""><figcaption>Two &#x3C;pictures><\/figcaption><\/figure>$/,
  );
  expect(result?.firstImageUrl).toContain("cdn.bsky.app");
});

it("discovers galleries and renders nothing without their record", async () => {
  const galleryUri = `at://${did}/blog.pckt.gallery/one`;
  const content = {
    $type: "blog.pckt.content",
    items: [
      { $type: "blog.pckt.block.text", plaintext: "Text" },
      { $type: "blog.pckt.block.gallery", ref: galleryUri },
    ],
  };
  expect(discoverReferences(content, did)).toEqual([galleryUri]);
  const result = await convertDocumentContent(
    { content },
    { did, loadBlob: () => Promise.reject(new Error("no blobs")) },
  );
  expect(result?.html).toBe("<p>Text</p>");
});

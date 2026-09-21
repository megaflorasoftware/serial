import { describe, expect, it } from "vitest";
import {
  deriveResolvedContent,
  discoverReferences,
  referencedPublications,
} from "../src";
import type { RecordLookup } from "../src";
import { buildBlueskyCdnImageUrl } from "../src/uris";

const did = "did:plc:alice";
const uri = `at://${did}/site.standard.document/article`;
const site = `at://did:plc:publisher/site.standard.publication/site`;
const card = (uri: string): Record<string, unknown> => ({
  $type: "pub.leaflet.blocks.standardSitePost",
  uri,
});
function content(uris: string[]) {
  return {
    $type: "pub.leaflet.content",
    pages: [
      {
        $type: "pub.leaflet.pages.linearDocument",
        blocks: uris.map((uri) => ({ block: card(uri) })),
      },
    ],
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
function cards(value: unknown, records?: RecordLookup) {
  return (
    deriveResolvedContent(value, did, records)?.blocks.flatMap((block) =>
      block.kind === "recordPreview" ? [block.card] : [],
    ) ?? []
  );
}

describe("embedded standard.site records", () => {
  it("renders resolved records as canonical cards", () => {
    const result = cards(
      content([uri, uri]),
      lookup({ [uri]: documentRecord(uri) }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      uri,
      url: "https://example.com/article",
      title: "An article",
      size: "row",
    });
  });
  it("points at the record inspector when a reference is unresolved", () => {
    expect(cards(content([uri]))).toEqual([
      {
        uri,
        url: `https://pdsls.dev/${uri}`,
        title: "Embedded document",
        description: uri,
        size: "row",
      },
    ]);
  });
  it("discovers distinct rendered references, capped at sixteen", () => {
    const many = Array.from({ length: 100 }, (_, i) => `${uri}${i}`);
    expect(discoverReferences(content(many), did)).toHaveLength(16);
    expect(discoverReferences(content([uri, uri]), did)).toEqual([uri]);
  });

  it("discovers cards from linear pages and lists but not canvas pages or unknown fields", () => {
    const visible = `${uri}-visible`;
    const listed = `${uri}-listed`;
    const decoy = `${uri}-decoy`;
    const input = content([visible]);
    input.pages.unshift({
      $type: "pub.leaflet.pages.canvas",
      blocks: Array.from({ length: 16 }, (_, index) => ({
        block: card(`${decoy}-canvas-${index}`),
      })),
    });
    Object.assign(input, {
      unknown: Array.from({ length: 16 }, (_, index) =>
        card(`${decoy}-unknown-${index}`),
      ),
    });
    input.pages[1]!.blocks.unshift({
      block: {
        $type: "pub.leaflet.blocks.unorderedList",
        children: [{ content: card(listed) }],
      },
    });
    // List items only hold text and images, so a card inside one is dropped.
    expect(discoverReferences(input, did)).toEqual([visible]);
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

  it("renders publication names from their snapshots", () => {
    const [result] = cards(
      content([uri]),
      lookup({
        [uri]: documentRecord(uri, { site }),
        [site]: {
          uri: site,
          cid: "bafy",
          value: { name: "Publication", url: "https://pub.example.com" },
        },
      }),
    );
    expect(result).toMatchObject({
      publicationName: "Publication",
      url: "https://pub.example.com/article",
    });
  });
});

it.each(["small", "medium", "large", undefined, "invalid"])(
  "carries size %s through validation",
  (size) => {
    const input = content([uri]);
    input.pages[0]!.blocks[0]!.block.size = size;
    const [result] = cards(
      input,
      lookup({
        [uri]: documentRecord(uri, {
          title: "A <title>",
          description: "Summary",
          coverImage: { ref: { $link: "bafycover" }, mimeType: "image/jpeg" },
        }),
      }),
    );
    expect(result?.size).toBe(size && size !== "invalid" ? size : "row");
    expect(result?.imageUrl).toContain("https://cdn.bsky.app/");
    expect(result?.title).toBe("A <title>");
  },
);

it.each(["pub.leaflet", "blog.pckt"])(
  "resolves %s AT mentions and preserves UTF-8 text",
  (prefix) => {
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
    const value =
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
    expect(discoverReferences(value, did)).toEqual([uri]);
    const document = deriveResolvedContent(
      value,
      did,
      lookup({
        [uri]: documentRecord(uri, { path: "/notes", title: "Replacement" }),
      }),
    );
    expect(document?.blocks[0]).toMatchObject({
      kind: "paragraph",
      content: [
        { kind: "text", text: "🌿 ", link: null },
        {
          kind: "text",
          text: "Field Notes",
          link: { href: "https://example.com/notes", record: uri },
        },
        { kind: "text", text: "!", link: null },
      ],
    });
    expect(document?.blocks[1]).toMatchObject({ kind: "recordPreview" });
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
  const value = {
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
  expect(discoverReferences(value, did)).toEqual([uri, footnoteUri]);
});

it("keeps a generic row when required preview metadata is invalid", () => {
  const [result] = cards(
    content([uri]),
    lookup({ [uri]: documentRecord(uri, { title: "x".repeat(10_001) }) }),
  );
  expect(result).toMatchObject({
    size: "row",
    url: `https://pdsls.dev/${uri}`,
  });
});

it("drops oversized optional metadata without dropping the card", () => {
  const [result] = cards(
    content([uri]),
    lookup({
      [uri]: documentRecord(uri, {
        title: "Title",
        description: "x".repeat(10_001),
      }),
    }),
  );
  expect(result).toMatchObject({ title: "Title" });
  expect(result?.description).toBeUndefined();
});

it("renders pckt galleries from their referenced record", () => {
  const galleryUri = `at://did:plc:bob/blog.pckt.gallery/one`;
  const document = deriveResolvedContent(
    {
      $type: "blog.pckt.content",
      items: [{ $type: "blog.pckt.block.gallery", ref: galleryUri }],
    },
    did,
    lookup({
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
  );
  // Gallery blobs belong to the gallery's repository, not the document's.
  expect(document?.blocks[0]).toMatchObject({
    kind: "imageGroup",
    layout: { mode: "stack" },
    images: [
      { url: buildBlueskyCdnImageUrl("did:plc:bob", "bafyone"), alt: "One" },
      { url: "https://example.com/two.png", alt: "" },
    ],
    caption: [{ kind: "text", text: "Two <pictures>" }],
  });
});

it("discovers galleries and shows the notice without their record", () => {
  const galleryUri = `at://${did}/blog.pckt.gallery/one`;
  const value = {
    $type: "blog.pckt.content",
    items: [
      { $type: "blog.pckt.block.text", plaintext: "Text" },
      { $type: "blog.pckt.block.gallery", ref: galleryUri },
    ],
  };
  expect(discoverReferences(value, did)).toEqual([galleryUri]);
  expect(
    deriveResolvedContent(value, did)?.blocks.map((block) => block.kind),
  ).toEqual(["paragraph", "notice"]);
});

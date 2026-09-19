import { describe, expect, it, vi } from "vitest";
import { convertDocumentContent } from "../src";

const did = "did:plc:alice";
const uri = `at://${did}/site.standard.document/article`;
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
describe("embedded standard.site records", () => {
  it("uses canonical record links and deduplicates direct references", async () => {
    const resolveRecord = vi.fn(async () => ({
      url: "https://example.com/article",
      title: "An article",
    }));
    const result = await convertDocumentContent(document([uri, uri]), {
      did,
      loadBlob: vi.fn(),
      resolveRecord,
    });
    expect(resolveRecord).toHaveBeenCalledExactlyOnceWith(uri);
    expect(result?.html).toContain('href="https://example.com/article"');
    expect(result?.html).toContain("An article");
  });
  it("retains the existing link card when a reference cannot resolve", async () => {
    const result = await convertDocumentContent(document([uri]), {
      did,
      loadBlob: vi.fn(),
      resolveRecord: async () => null,
    });
    expect(result?.html).toContain(`https://pdsls.dev/${uri}`);
  });
  it("bounds direct resolution to sixteen distinct references", async () => {
    const resolveRecord = vi.fn(async () => null);
    await convertDocumentContent(
      document(Array.from({ length: 100 }, (_, i) => `${uri}${i}`)),
      { did, loadBlob: vi.fn(), resolveRecord },
    );
    expect(resolveRecord).toHaveBeenCalledTimes(16);
  });

  it("resolves only cards emitted from linear pages", async () => {
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
    const resolveRecord = vi.fn(async (candidate: string) => {
      if (candidate !== visible)
        throw new Error("unrendered reference fetched");
      return { url: "https://example.com/visible", title: "Visible" };
    });
    const result = await convertDocumentContent(input, {
      did,
      loadBlob: vi.fn(),
      resolveRecord,
    });
    expect(resolveRecord).toHaveBeenCalledExactlyOnceWith(visible);
    expect(result?.html).toContain('href="https://example.com/visible"');
  });

  it("resolves cards from overflowed Leaflet pages", async () => {
    const resolveRecord = vi.fn(async () => ({
      url: "https://example.com/overflow",
      title: "Overflow",
    }));
    const pages = document([uri]).content.pages;
    const result = await convertDocumentContent(
      {
        content: {
          $type: "pub.leaflet.content",
          blobPages: { ref: { $link: "bafypages" } },
        },
      },
      {
        did,
        loadBlob: vi.fn(async () =>
          new TextEncoder().encode(JSON.stringify(pages)),
        ),
        resolveRecord,
      },
    );
    expect(resolveRecord).toHaveBeenCalledExactlyOnceWith(uri);
    expect(result?.html).toContain('href="https://example.com/overflow"');
  });
});

it.each(["small", "medium", "large", undefined, "invalid"])(
  "preserves size %s through sanitization",
  async (size) => {
    const input = document([uri]);
    input.content.pages[0]!.blocks[0]!.block.size = size;
    const result = await convertDocumentContent(input, {
      did,
      loadBlob: vi.fn(),
      resolveRecord: async () => ({
        url: "https://example.com/post",
        title: "A <title>",
        description: "Summary",
        imageUrl: "https://example.com/cover.jpg",
      }),
    });
    expect(result?.html).toContain(
      `data-size="${size && size !== "invalid" ? size : "row"}"`,
    );
    expect(result?.html).toContain(
      'data-image-url="https://example.com/cover.jpg"',
    );
    expect(result?.html).toContain("<strong>A &#x3C;title></strong>");
  },
);

it("keeps the body and row fallback when record services fail", async () => {
  const input = document([uri]);
  input.content.pages[0]!.blocks[0]!.block.size = "large";
  const result = await convertDocumentContent(input, {
    did,
    loadBlob: vi.fn(),
    resolveRecord: async () => {
      throw new Error("offline");
    },
  });
  expect(result?.html).toContain('data-size="row"');
  expect(result?.html).toContain(`href="https://pdsls.dev/${uri}"`);
});

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
    const resolveRecord = vi.fn(async () => ({
      url: "https://example.com/notes",
      title: "Replacement title",
    }));
    const result = await convertDocumentContent(
      { content },
      { did, loadBlob: vi.fn(), resolveRecord },
    );
    expect(result?.html).toContain(
      `🌿 <a href="https://example.com/notes" data-record-uri="${uri}">Field Notes</a>!`,
    );
    expect(resolveRecord).toHaveBeenCalledExactlyOnceWith(uri);
    expect(result?.html).toContain('data-serial-embed="record"');
  },
);

it("resolves mentions inside nested lists and footnotes but not empty byte ranges", async () => {
  const mention = (target: string) => ({
    index: { byteStart: 0, byteEnd: 4 },
    features: [
      { $type: "pub.leaflet.richtext.facet#atMention", atURI: target },
    ],
  });
  const footnoteUri = `${uri}-footnote`;
  const result = await convertDocumentContent(
    {
      content: {
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
      },
    },
    {
      did,
      loadBlob: vi.fn(),
      resolveRecord: async (target) => {
        expect([uri, footnoteUri]).toContain(target);
        return {
          url: `https://example.com/${target === uri ? "list" : "note"}`,
          title: "Title",
        };
      },
    },
  );
  expect(result?.html).toContain('href="https://example.com/list"');
  expect(result?.html).toContain('href="https://example.com/note"');
});

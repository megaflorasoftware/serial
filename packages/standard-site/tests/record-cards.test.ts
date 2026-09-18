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

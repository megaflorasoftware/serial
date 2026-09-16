import { describe, expect, it, vi } from "vitest";
import { convertDocumentContent } from "../src";

const did = "did:plc:alice";
const uri = `at://${did}/site.standard.document/article`;
function document(uris: string[]) {
  return {
    content: {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: uris.map((uri) => ({
            block: { $type: "pub.leaflet.blocks.standardSitePost", uri },
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
});

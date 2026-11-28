import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  deriveReaderDocument,
  deriveResolvedContent,
  documentSourceBytes,
  isReferenceSnapshotStale,
  overflowBlobCid,
  readerBodyBytes,
  resolveDocumentSourceContent,
  stringifyLosslessJson,
} from "../src";
import type { ReaderBody, SourceReaderBody } from "../src";
import {
  FIXTURE_DOCUMENTS,
  fixtureReaderBody,
  loadDocumentFixture,
  typedDocument,
} from "./fixtures";

const did = "did:plc:example";

function sourceBody(
  uri: string,
  record: string,
  blobs: SourceReaderBody["source"]["blobs"] = [],
  references: SourceReaderBody["references"] = [],
): SourceReaderBody {
  return {
    form: "source",
    source: { uri, cid: "bafysource", record, blobs },
    references,
    revision: "bafysource",
  };
}

describe("source-form Reader bodies", () => {
  it.each(FIXTURE_DOCUMENTS)(
    "%s derives the same Reader document from its body as from resolved content",
    (name) => {
      const { record, did: fixtureDid } = loadDocumentFixture(name);
      const body = fixtureReaderBody(name);
      const fromContent = deriveResolvedContent(
        record.value.content,
        fixtureDid,
      );
      const fromBody = deriveReaderDocument(
        { ...body, references: [] },
        fixtureDid,
      );
      expect(fromBody).not.toBeNull();
      expect(typedDocument(fromBody!)).toEqual(typedDocument(fromContent!));
    },
  );

  it("inlines a retained pckt overflow blob", () => {
    const items = [{ $type: "blog.pckt.block.text", plaintext: "from blob" }];
    const content = {
      $type: "blog.pckt.content",
      blob: { ref: { $link: "bafyitems" }, mimeType: "application/json" },
    };
    expect(overflowBlobCid(content)).toBe("bafyitems");
    const body = sourceBody(
      `at://${did}/site.standard.document/post`,
      stringifyLosslessJson({ title: "Post", content }),
      [
        {
          cid: "bafyitems",
          mimeType: "application/json",
          bytes: bytesToBase64(new TextEncoder().encode(JSON.stringify(items))),
        },
      ],
    );
    expect(deriveReaderDocument(body, did)?.blocks).toMatchObject([
      { kind: "paragraph", content: [{ kind: "text", text: "from blob" }] },
    ]);
  });

  it("derives nothing when the overflow blob was not retained", () => {
    const content = {
      $type: "pub.leaflet.content",
      pages: [],
      blobPages: { ref: { $link: "bafypages" } },
    };
    expect(overflowBlobCid(content)).toBe("bafypages");
    expect(overflowBlobCid({ $type: "pub.leaflet.content", pages: [] })).toBe(
      null,
    );
    const body = sourceBody(
      `at://${did}/site.standard.document/post`,
      stringifyLosslessJson({ title: "Post", content }),
    );
    expect(resolveDocumentSourceContent(body.source)).toBeNull();
    expect(deriveReaderDocument(body, did)).toBeNull();
  });

  it("reads leaflet pages from blobPages and ignores inline pages", () => {
    const pages = [
      {
        $type: "pub.leaflet.pages.linearDocument",
        blocks: [
          {
            block: { $type: "pub.leaflet.blocks.text", plaintext: "from blob" },
          },
        ],
      },
    ];
    const content = {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: [
            {
              block: { $type: "pub.leaflet.blocks.text", plaintext: "inline" },
            },
          ],
        },
      ],
      blobPages: { ref: { $link: "bafypages" } },
    };
    const body = sourceBody(
      `at://${did}/site.standard.document/post`,
      stringifyLosslessJson({ content }),
      [
        {
          cid: "bafypages",
          mimeType: null,
          bytes: bytesToBase64(new TextEncoder().encode(JSON.stringify(pages))),
        },
      ],
    );
    expect(deriveReaderDocument(body, did)?.blocks).toMatchObject([
      { kind: "paragraph", content: [{ kind: "text", text: "from blob" }] },
    ]);
  });

  it("renders cards from resolved snapshots and ignores the rest", () => {
    const target = `at://${did}/site.standard.document/other`;
    const body = sourceBody(
      `at://${did}/site.standard.document/post`,
      stringifyLosslessJson({
        content: {
          $type: "pub.leaflet.content",
          pages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: {
                    $type: "pub.leaflet.blocks.standardSitePost",
                    uri: target,
                  },
                },
              ],
            },
          ],
        },
      }),
      [],
      [
        {
          uri: target,
          cid: "bafyother",
          outcome: "resolved",
          record: stringifyLosslessJson({
            site: "https://example.com",
            title: "Other post",
            path: "/other",
            publishedAt: "2026-09-18T00:00:00Z",
            views: 9007199254740993n,
          }),
          resolvedAt: "2026-09-19T00:00:00Z",
        },
        {
          uri: `${target}-missing`,
          cid: null,
          outcome: "missing",
          record: null,
          resolvedAt: "2026-09-19T00:00:00Z",
        },
      ],
    );
    expect(deriveReaderDocument(body, did)?.blocks[0]).toMatchObject({
      kind: "recordPreview",
      card: { url: "https://example.com/other", title: "Other post" },
    });
  });

  it("measures source and body bytes from decoded blob sizes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = bytesToBase64(bytes);
    expect(base64ToBytes(encoded)).toEqual(bytes);
    expect(
      documentSourceBytes({ record: "é", blobs: [{ bytes: encoded }] }),
    ).toBe(2 + 5);
    const html: ReaderBody = { form: "html", html: "<p>é</p>", revision: "h" };
    expect(readerBodyBytes(html)).toBe(9);
  });

  it("marks snapshots stale by outcome and age", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    const at = (minutesAgo: number) =>
      new Date(now - minutesAgo * 60_000).toISOString();
    expect(
      isReferenceSnapshotStale({ outcome: "resolved", resolvedAt: at(5) }, now),
    ).toBe(false);
    expect(
      isReferenceSnapshotStale(
        { outcome: "resolved", resolvedAt: at(16) },
        now,
      ),
    ).toBe(true);
    expect(
      isReferenceSnapshotStale(
        { outcome: "unavailable", resolvedAt: at(0) },
        now,
      ),
    ).toBe(true);
    expect(
      isReferenceSnapshotStale(
        { outcome: "missing", resolvedAt: at(6 * 24 * 60) },
        now,
      ),
    ).toBe(false);
    expect(
      isReferenceSnapshotStale(
        { outcome: "unsupported", resolvedAt: at(8 * 24 * 60) },
        now,
      ),
    ).toBe(true);
    expect(
      isReferenceSnapshotStale(
        { outcome: "resolved", resolvedAt: "never" },
        now,
      ),
    ).toBe(true);
  });
});

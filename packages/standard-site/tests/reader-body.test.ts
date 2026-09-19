import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  convertDocumentContent,
  convertReaderBody,
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
  loadDocumentFixture,
  readFixtureText,
  rejectingBlobLoader,
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
    "%s derives the same HTML from its source as from import",
    async (name) => {
      const { record, did: fixtureDid } = loadDocumentFixture(name);
      const text = readFixtureText(name);
      const value = JSON.parse(text) as { value: unknown };
      const imported = await convertDocumentContent(record.value, {
        did: fixtureDid,
        loadBlob: rejectingBlobLoader,
      });
      const derived = convertReaderBody(
        sourceBody(record.uri, stringifyLosslessJson(value.value)),
        fixtureDid,
      );
      expect(derived).toEqual(imported);
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
    expect(convertReaderBody(body, did)?.html).toBe("<p>from blob</p>");
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
    expect(convertReaderBody(body, did)).toBeNull();
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
    const html = convertReaderBody(body, did)?.html;
    expect(html).toContain('href="https://example.com/other"');
    expect(html).toContain("Other post");
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

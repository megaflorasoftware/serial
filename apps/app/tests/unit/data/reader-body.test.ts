import { describe, expect, it } from "vitest";
import type { ReaderBody } from "@serial/standard-site";
import {
  hasReaderBodyContent,
  readerContent,
} from "~/lib/data/feed-items/readerBody";

const LEAFLET_RECORD = JSON.stringify({
  content: {
    $type: "pub.leaflet.content",
    pages: [
      {
        $type: "pub.leaflet.pages.linearDocument",
        blocks: [
          {
            block: { $type: "pub.leaflet.blocks.text", plaintext: "Hello" },
          },
        ],
      },
    ],
  },
});

function sourceBody(record = LEAFLET_RECORD): ReaderBody {
  return {
    form: "source",
    source: {
      uri: "at://did:plc:alice/site.standard.document/post",
      cid: "bafy",
      record,
      blobs: [],
    },
    references: [],
    revision: "bafy",
  };
}

describe("reader content", () => {
  it("derives a Reader document from a Document source", () => {
    const content = readerContent(sourceBody());
    expect(content?.form).toBe("document");
    if (content?.form !== "document") throw new Error("expected a document");
    expect(content.document.blocks).toMatchObject([
      { kind: "paragraph", content: [{ kind: "text", text: "Hello" }] },
    ]);
  });

  it("passes an HTML body through as it stands", () => {
    expect(
      readerContent({ form: "html", html: "<p>Stored</p>", revision: "hash" }),
    ).toEqual({ form: "html", html: "<p>Stored</p>" });
  });

  it("yields nothing for an unloaded body or a source that does not derive", () => {
    expect(readerContent(null)).toBeNull();
    expect(readerContent(sourceBody("{}"))).toBeNull();
  });
});

describe("reader body presence", () => {
  it.each([
    ["an unloaded body", null, false],
    ["an empty HTML body", { form: "html", html: "  ", revision: "h" }, false],
    [
      "an HTML body",
      { form: "html", html: "<p>Body</p>", revision: "h" },
      true,
    ],
    ["a Document source", sourceBody(), true],
  ] as Array<[string, ReaderBody | null, boolean]>)(
    "reports %s",
    (_label, body, expected) => {
      expect(hasReaderBodyContent(body)).toBe(expected);
    },
  );
});

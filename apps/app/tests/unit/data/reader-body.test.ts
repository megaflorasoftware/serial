import { describe, expect, it } from "vitest";
import type { ReaderBody } from "@serial/standard-site";
import {
  hasReaderBodyContent,
  readerBodyHtml,
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

function sourceBody(): ReaderBody {
  return {
    form: "source",
    source: {
      uri: "at://did:plc:alice/site.standard.document/post",
      cid: "bafy",
      record: LEAFLET_RECORD,
      blobs: [],
    },
    references: [],
    revision: "bafy",
  };
}

describe("reader body derivation", () => {
  it("derives reader HTML from a Document source", () => {
    expect(readerBodyHtml(sourceBody())).toContain("<p>Hello</p>");
  });

  it("renders an HTML body as it stands", () => {
    expect(
      readerBodyHtml({
        form: "html",
        html: "<p>Stored</p>",
        revision: "hash",
      }),
    ).toBe("<p>Stored</p>");
  });

  it("renders nothing for an unloaded body", () => {
    expect(readerBodyHtml(null)).toBe("");
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

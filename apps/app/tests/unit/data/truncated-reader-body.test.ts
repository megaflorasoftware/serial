import { describe, expect, it } from "vitest";
import { isTruncatedReaderBody } from "~/lib/data/feed-items/readerBody";

const snippet = "A short summary of the post.";

describe("truncation alert bodies", () => {
  it("waits for a body before judging it partial", () => {
    expect(isTruncatedReaderBody(null, snippet)).toBe(false);
  });
  it("never flags a Document source", () => {
    expect(
      isTruncatedReaderBody(
        {
          form: "source",
          source: {
            uri: "at://did:plc:a/site.standard.document/p",
            cid: "c",
            record: "{}",
            blobs: [],
          },
          references: [],
          revision: "c",
        },
        snippet,
      ),
    ).toBe(false);
  });
  it("flags a partial HTML body and accepts a full one", () => {
    expect(
      isTruncatedReaderBody(
        { form: "html", html: "<p>Read more…</p>", revision: "h" },
        snippet,
      ),
    ).toBe(true);
    expect(
      isTruncatedReaderBody(
        {
          form: "html",
          html: Array.from(
            { length: 8 },
            (_, i) => `<p>${"Full paragraph text. ".repeat(6)}${i}</p>`,
          ).join(""),
          revision: "h",
        },
        snippet,
      ),
    ).toBe(false);
  });
});

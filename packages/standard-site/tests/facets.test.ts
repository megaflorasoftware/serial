import { describe, expect, it } from "vitest";
import {
  resolveRichText,
  richTextContext,
  richTextPlaintext,
} from "../src/reader/rich-text";
import type { ReaderInline, ReaderMarks } from "../src/reader/model";

const text = (
  value: string,
  marks: ReaderMarks = {},
  href?: string,
  record: string | null = null,
): ReaderInline => ({
  kind: "text",
  text: value,
  marks,
  link: href ? { href, record } : null,
});
const note = (number: number): ReaderInline => ({ kind: "footnote", number });

describe("resolveRichText", () => {
  it("numbers unsorted and overlapping footnotes by first displayed marker", () => {
    const context = richTextContext();
    const reference = (start: number, end: number, id: string) => ({
      index: { byteStart: start, byteEnd: end },
      features: [{ $type: "x#footnote", footnoteId: id, contentPlaintext: id }],
    });
    const inlines = resolveRichText(
      {
        plaintext: "abcdef",
        facets: [
          reference(4, 6, "last"),
          reference(0, 4, "middle"),
          reference(1, 2, "first"),
          reference(5, 6, "first"),
        ],
      },
      context,
    );
    expect(inlines).toEqual([
      text("ab"),
      note(1),
      text("cd"),
      note(2),
      text("ef"),
      note(3),
      note(1),
    ]);
    expect(
      context.footnotes.map((footnote) => [
        footnote.number,
        richTextPlaintext(footnote.content),
      ]),
    ).toEqual([
      [1, "first"],
      [2, "middle"],
      [3, "last"],
    ]);
  });

  it("keeps the outermost link when ranges start together and end separately", () => {
    expect(
      resolveRichText({
        plaintext: "abcdef",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 2 },
            features: [{ $type: "x#link", uri: "https://inner.test" }],
          },
          {
            index: { byteStart: 2, byteEnd: 6 },
            features: [{ $type: "x#italic" }],
          },
          {
            index: { byteStart: 0, byteEnd: 4 },
            features: [{ $type: "x#link", uri: "https://outer.test" }],
          },
        ],
      }),
    ).toEqual([
      text("ab", {}, "https://outer.test/"),
      text("cd", { italic: true }, "https://outer.test/"),
      text("ef", { italic: true }),
    ]);
  });

  it("resolves a dense document with disjoint facet ranges into alternating spans", () => {
    const count = 10000;
    const inlines = resolveRichText({
      plaintext: "x".repeat(count),
      facets: Array.from({ length: count / 2 }, (_, index) => ({
        index: { byteStart: index * 2, byteEnd: index * 2 + 1 },
        features: [{ $type: "x#bold" }],
      })),
    });
    expect(inlines).toHaveLength(count);
    expect(inlines[0]).toEqual(text("x", { bold: true }));
    expect(inlines[1]).toEqual(text("x"));
  });

  it("joins adjacent spans that share formatting and link", () => {
    expect(
      resolveRichText({
        plaintext: "abcd",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 2 },
            features: [{ $type: "x#bold" }],
          },
          {
            index: { byteStart: 2, byteEnd: 4 },
            features: [{ $type: "x#bold" }],
          },
        ],
      }),
    ).toEqual([text("abcd", { bold: true })]);
  });

  it("keeps footnote numbers stable across paragraphs", () => {
    const context = richTextContext();
    const reference = (id: string, content: string) =>
      resolveRichText(
        {
          plaintext: "x",
          facets: [
            {
              index: { byteStart: 0, byteEnd: 1 },
              features: [
                {
                  $type: "x#footnote",
                  footnoteId: id,
                  contentPlaintext: content,
                },
              ],
            },
          ],
        },
        context,
      );
    expect(reference("first", "one")).toEqual([text("x"), note(1)]);
    expect(reference("second", "two")).toEqual([text("x"), note(2)]);
    expect(reference("first", "duplicate")).toEqual([text("x"), note(1)]);
    expect(reference("second", "duplicate")).toEqual([text("x"), note(2)]);
    expect(
      context.footnotes.map((footnote) => richTextPlaintext(footnote.content)),
    ).toEqual(["one", "two"]);
  });

  it("returns one span for plaintext without facets and none for empty text", () => {
    expect(resolveRichText({ plaintext: "a < b & c" })).toEqual([
      text("a < b & c"),
    ]);
    expect(resolveRichText({ plaintext: "" })).toEqual([]);
  });

  it("slices facets by UTF-8 byte offsets", () => {
    const plaintext = "héllo wörld";
    expect(new TextEncoder().encode(plaintext).length).toBe(13);
    expect(
      resolveRichText({
        plaintext,
        facets: [
          {
            index: { byteStart: 7, byteEnd: 13 },
            features: [{ $type: "pub.leaflet.richtext.facet#bold" }],
          },
        ],
      }),
    ).toEqual([text("héllo "), text("wörld", { bold: true })]);
  });

  it("splits overlapping facets at every boundary with the union of marks", () => {
    expect(
      resolveRichText({
        plaintext: "abcdef",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 4 },
            features: [{ $type: "x#bold" }],
          },
          {
            index: { byteStart: 2, byteEnd: 6 },
            features: [{ $type: "x#italic" }],
          },
        ],
      }),
    ).toEqual([
      text("ab", { bold: true }),
      text("cd", { bold: true, italic: true }),
      text("ef", { italic: true }),
    ]);
  });

  it("maps every supported feature", () => {
    const plaintext = "link web did at u m s c h";
    const feature = (
      start: number,
      end: number,
      value: { $type: string } & Record<string, unknown>,
    ) => ({ index: { byteStart: start, byteEnd: end }, features: [value] });
    expect(
      resolveRichText({
        plaintext,
        facets: [
          feature(0, 4, { $type: "x#link", uri: "https://a.test/?q=1&r=2" }),
          feature(5, 8, {
            $type: "x#webMention",
            uri: "https://b.test",
            title: "B",
          }),
          feature(9, 12, {
            $type: "x#mention",
            did: "did:plc:abc",
            handle: "abc",
          }),
          feature(13, 15, {
            $type: "x#atMention",
            atURI: "at://did:plc:x/site.standard.document/b",
            href: "https://c.test",
          }),
          feature(16, 17, { $type: "x#underline" }),
          feature(18, 19, { $type: "x#highlight", color: "#ff0" }),
          feature(20, 21, { $type: "x#strikethrough" }),
          feature(22, 23, { $type: "x#code" }),
          feature(24, 25, { $type: "x#id", id: "anchor" }),
        ],
      }),
    ).toEqual([
      text("link", {}, "https://a.test/?q=1&r=2"),
      text(" "),
      text("web", {}, "https://b.test/"),
      text(" "),
      text("did", {}, "https://bsky.app/profile/did:plc:abc"),
      text(" "),
      text(
        "at",
        {},
        "https://c.test/",
        "at://did:plc:x/site.standard.document/b",
      ),
      text(" "),
      text("u", { underline: true }),
      text(" "),
      text("m", { highlight: { color: "#ff0" } }),
      text(" "),
      text("s", { strikethrough: true }),
      text(" "),
      text("c", { code: true }),
      text(" h"),
    ]);
  });

  it("carries a highlight without a color and keeps mailto links", () => {
    expect(
      resolveRichText({
        plaintext: "write",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 5 },
            features: [
              { $type: "x#link", uri: "mailto:a@b.test" },
              { $type: "x#highlight" },
            ],
          },
        ],
      }),
    ).toEqual([
      text("write", { highlight: { color: null } }, "mailto:a@b.test"),
    ]);
  });

  it("keeps the authored href of a mention whose URI has no inspector page", () => {
    expect(
      resolveRichText({
        plaintext: "at",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 2 },
            features: [
              {
                $type: "x#atMention",
                atURI: "at://did:plc:x/a/b",
                href: "https://c.test",
              },
            ],
          },
        ],
      }),
    ).toEqual([text("at", {}, "https://c.test/")]);
  });

  it("rejects malformed dids", () => {
    expect(
      resolveRichText({
        plaintext: "one two",
        facets: [
          {
            index: { byteStart: 4, byteEnd: 7 },
            features: [{ $type: "x#mention", did: 'did:plc:x" onclick="x()' }],
          },
        ],
      }),
    ).toEqual([text("one two")]);
  });

  it("keeps only the outermost link when link facets overlap", () => {
    expect(
      resolveRichText({
        plaintext: "abcdef",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 4 },
            features: [{ $type: "x#link", uri: "https://a.test" }],
          },
          {
            index: { byteStart: 2, byteEnd: 6 },
            features: [{ $type: "x#link", uri: "https://b.test" }],
          },
        ],
      }),
    ).toEqual([
      text("abcd", {}, "https://a.test/"),
      text("ef", {}, "https://b.test/"),
    ]);
  });

  it("emits a footnote reference once at the end of the facet", () => {
    const context = richTextContext();
    expect(
      resolveRichText(
        {
          plaintext: "abcdef",
          facets: [
            {
              index: { byteStart: 0, byteEnd: 6 },
              features: [
                {
                  $type: "x#footnote",
                  footnoteId: "n1",
                  contentPlaintext: "note",
                },
              ],
            },
            {
              index: { byteStart: 2, byteEnd: 4 },
              features: [{ $type: "x#bold" }],
            },
          ],
        },
        context,
      ),
    ).toEqual([text("ab"), text("cd", { bold: true }), text("ef"), note(1)]);
    expect(context.footnotes).toHaveLength(1);
  });

  it("shares one entry between references to the same footnote id", () => {
    const context = richTextContext();
    const shared = {
      $type: "x#footnote",
      footnoteId: "same",
      contentPlaintext: "note",
    };
    expect(
      resolveRichText(
        {
          plaintext: "ab cd",
          facets: [
            { index: { byteStart: 0, byteEnd: 2 }, features: [shared] },
            { index: { byteStart: 3, byteEnd: 5 }, features: [shared] },
          ],
        },
        context,
      ),
    ).toEqual([text("ab"), note(1), text(" cd"), note(1)]);
    expect(context.footnotes).toHaveLength(1);
  });

  it("lists a footnote nested inside footnote text after its parent", () => {
    const context = richTextContext();
    const body = resolveRichText(
      {
        plaintext: "claim",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 5 },
            features: [
              {
                $type: "x#footnote",
                footnoteId: "outer",
                contentPlaintext: "outer note",
                contentFacets: [
                  {
                    index: { byteStart: 0, byteEnd: 5 },
                    features: [
                      {
                        $type: "x#footnote",
                        footnoteId: "inner",
                        contentPlaintext: "inner note",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      context,
    );
    expect(body).toEqual([text("claim"), note(1)]);
    expect(context.footnotes.map((footnote) => footnote.number)).toEqual([
      1, 2,
    ]);
    expect(context.footnotes[0]!.content).toEqual([
      text("outer"),
      note(2),
      text(" note"),
    ]);
    expect(richTextPlaintext(context.footnotes[1]!.content)).toBe("inner note");
  });

  it("snaps byte offsets that split a code point forward to the next one", () => {
    // "é" occupies bytes 1 and 2, so an offset of 2 moves forward to 3.
    expect(
      resolveRichText({
        plaintext: "héllo",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 2 },
            features: [{ $type: "x#bold" }],
          },
          {
            index: { byteStart: 2, byteEnd: 4 },
            features: [{ $type: "x#italic" }],
          },
        ],
      }),
    ).toEqual([
      text("hé", { bold: true }),
      text("l", { italic: true }),
      text("lo"),
    ]);
  });

  it("drops unsafe links and out-of-range facets", () => {
    expect(
      resolveRichText({
        plaintext: "js and beyond",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 2 },
            features: [{ $type: "x#link", uri: "javascript:alert(1)" }],
          },
          {
            index: { byteStart: 7, byteEnd: 99 },
            features: [{ $type: "x#bold" }],
          },
          {
            index: { byteStart: 50, byteEnd: 60 },
            features: [{ $type: "x#italic" }],
          },
        ],
      }),
    ).toEqual([text("js and "), text("beyond", { bold: true })]);
  });
});

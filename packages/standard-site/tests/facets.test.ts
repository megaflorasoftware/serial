import { describe, expect, it } from "vitest";
import { renderFootnotes, renderRichText } from "../src/convert/facets";

describe("renderRichText", () => {
  it("preserves link precedence when ranges start together and end separately", () => {
    expect(
      renderRichText({
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
    ).toBe(
      '<a href="https://outer.test/">ab</a><a href="https://outer.test/"><em>cd</em></a><em>ef</em>',
    );
  });

  it("renders a dense document with disjoint facet ranges", () => {
    const count = 10000;
    expect(
      renderRichText({
        plaintext: "x".repeat(count),
        facets: Array.from({ length: count }, (_, index) => ({
          index: { byteStart: index, byteEnd: index + 1 },
          features: [{ $type: "x#bold" }],
        })),
      }),
    ).toBe("<strong>x</strong>".repeat(count));
  });

  it("keeps footnote numbers stable across paragraphs and preexisting notes", () => {
    const context = {
      footnotes: [{ id: "first", text: { plaintext: "one" } }],
    };
    const reference = (id: string, content: string) =>
      renderRichText(
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
    expect(reference("first", "duplicate")).toBe("x<sup>[1]</sup>");
    expect(reference("second", "two")).toBe("x<sup>[2]</sup>");
    expect(reference("first", "duplicate")).toBe("x<sup>[1]</sup>");
    expect(reference("second", "duplicate")).toBe("x<sup>[2]</sup>");
    expect(renderFootnotes(context)).toBe(
      "<section><ol><li>one</li><li>two</li></ol></section>",
    );
  });

  it("escapes plaintext without facets", () => {
    expect(renderRichText({ plaintext: "a < b & c" })).toBe(
      "a &#x3C; b &#x26; c",
    );
  });

  it("slices facets by UTF-8 byte offsets", () => {
    const plaintext = "héllo wörld";
    const bytes = new TextEncoder().encode(plaintext);
    expect(bytes.length).toBe(13);
    expect(
      renderRichText({
        plaintext,
        facets: [
          {
            index: { byteStart: 7, byteEnd: 13 },
            features: [{ $type: "pub.leaflet.richtext.facet#bold" }],
          },
        ],
      }),
    ).toBe("héllo <strong>wörld</strong>");
  });

  it("nests overlapping facets by reopening at every boundary", () => {
    expect(
      renderRichText({
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
    ).toBe("<strong>ab</strong><strong><em>cd</em></strong><em>ef</em>");
  });

  it("maps every supported feature", () => {
    const plaintext = "link web did at u m s c h";
    const feature = (
      start: number,
      end: number,
      value: { $type: string } & Record<string, unknown>,
    ) => ({
      index: { byteStart: start, byteEnd: end },
      features: [value],
    });
    expect(
      renderRichText({
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
            atURI: "at://did:plc:x/a/b",
            href: "https://c.test",
          }),
          feature(16, 17, { $type: "x#underline" }),
          feature(18, 19, {
            $type: "x#highlight",
            color: { r: 1, g: 2, b: 3 },
          }),
          feature(20, 21, { $type: "x#strikethrough" }),
          feature(22, 23, { $type: "x#code" }),
          feature(24, 25, { $type: "x#id", id: "anchor" }),
        ],
      }),
    ).toBe(
      '<a href="https://a.test/?q=1&#x26;r=2">link</a> <a href="https://b.test/">web</a> <a href="https://bsky.app/profile/did:plc:abc">did</a> <a href="https://c.test/">at</a> <u>u</u> <mark>m</mark> <del>s</del> <code>c</code> h',
    );
  });

  it("keeps mailto links", () => {
    expect(
      renderRichText({
        plaintext: "write",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 5 },
            features: [{ $type: "x#link", uri: "mailto:a@b.test" }],
          },
        ],
      }),
    ).toBe('<a href="mailto:a@b.test">write</a>');
  });

  it("escapes attribute values and rejects malformed dids", () => {
    const plaintext = "one two";
    expect(
      renderRichText({
        plaintext,
        facets: [
          {
            index: { byteStart: 0, byteEnd: 3 },
            features: [{ $type: "x#link", uri: "https://a.test/?q=\"'<" }],
          },
          {
            index: { byteStart: 4, byteEnd: 7 },
            features: [{ $type: "x#mention", did: 'did:plc:x" onclick="x()' }],
          },
        ],
      }),
    ).toBe('<a href="https://a.test/?q=%22%27%3C">one</a> two');
  });

  it("keeps only the outermost link when link facets overlap", () => {
    expect(
      renderRichText({
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
    ).toBe(
      '<a href="https://a.test/">ab</a><a href="https://a.test/">cd</a><a href="https://b.test/">ef</a>',
    );
  });

  it("emits a footnote marker once at the end of the facet", () => {
    const context = { footnotes: [] };
    expect(
      renderRichText(
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
    ).toBe("ab<strong>cd</strong>ef<sup>[1]</sup>");
    expect(context.footnotes).toHaveLength(1);
  });

  it("shares one entry between references to the same footnote id", () => {
    const context = { footnotes: [] };
    const note = {
      $type: "x#footnote",
      footnoteId: "same",
      contentPlaintext: "note",
    };
    expect(
      renderRichText(
        {
          plaintext: "ab cd",
          facets: [
            { index: { byteStart: 0, byteEnd: 2 }, features: [note] },
            { index: { byteStart: 3, byteEnd: 5 }, features: [note] },
          ],
        },
        context,
      ),
    ).toBe("ab<sup>[1]</sup> cd<sup>[1]</sup>");
    expect(renderFootnotes(context)).toBe(
      "<section><ol><li>note</li></ol></section>",
    );
  });

  it("maps didMention to a profile link", () => {
    expect(
      renderRichText({
        plaintext: "hi",
        facets: [
          {
            index: { byteStart: 0, byteEnd: 2 },
            features: [
              {
                $type: "pub.leaflet.richtext.facet#didMention",
                did: "did:plc:zz",
              },
            ],
          },
        ],
      }),
    ).toBe('<a href="https://bsky.app/profile/did:plc:zz">hi</a>');
  });

  it("lists a footnote nested inside footnote text after its parent", () => {
    const context = { footnotes: [] };
    const body = renderRichText(
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
    expect(body).toBe("claim<sup>[1]</sup>");
    expect(renderFootnotes(context)).toBe(
      "<section><ol><li>outer<sup>[2]</sup> note</li><li>inner note</li></ol></section>",
    );
  });

  it("snaps byte offsets that split a code point forward to the next one", () => {
    // "é" occupies bytes 1 and 2, so an offset of 2 moves forward to 3.
    expect(
      renderRichText({
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
    ).toBe("<strong>hé</strong><em>l</em>lo");
  });

  it("drops unsafe links and out-of-range facets", () => {
    expect(
      renderRichText({
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
    ).toBe("js and <strong>beyond</strong>");
  });
});

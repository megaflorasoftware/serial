import { describe, expect, it } from "vitest";
import { renderRichText } from "../src/convert/facets";

describe("renderRichText", () => {
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
      '<a href="https://a.test/?q=1&r=2">link</a> <a href="https://b.test/">web</a> <a href="https://bsky.app/profile/did:plc:abc">did</a> <a href="https://c.test/">at</a> <u>u</u> <mark>m</mark> <del>s</del> <code>c</code> h',
    );
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

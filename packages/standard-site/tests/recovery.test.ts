import { describe, expect, it } from "vitest";
import {
  convertDocumentContent,
  convertResolvedContent,
  INTERACTIVE_PLACEHOLDER_TEXT,
} from "../src/convert";
import { renderRichText } from "../src/convert/facets";
import { sanitizeArticleHtml } from "../src/sanitize";
import { leaflet, offprint, pckt, stubBlobLoader } from "./fixtures";

const did = "did:plc:example";
const pcktText = (plaintext: string) => ({
  $type: "blog.pckt.block.text",
  plaintext,
});
const offprintText = (plaintext: string) => ({
  $type: "app.offprint.block.text",
  plaintext,
});

function convert(content: unknown) {
  const result = convertResolvedContent(content, did);
  expect(result).not.toBeNull();
  expect(sanitizeArticleHtml(result!.html)).toBe(result!.html);
  return result!;
}

describe("malformed content recovery", () => {
  it.each(["text", "header"])(
    "drops whitespace-only Leaflet %s list text but preserves children",
    (kind) => {
      const result = convert(
        leaflet([
          {
            $type: "pub.leaflet.blocks.unorderedList",
            children: [
              {
                content: {
                  $type: `pub.leaflet.blocks.${kind}`,
                  plaintext: " \n",
                },
              },
              {
                content: {
                  $type: `pub.leaflet.blocks.${kind}`,
                  plaintext: " \n",
                },
                children: [
                  {
                    content: {
                      $type: "pub.leaflet.blocks.text",
                      plaintext: "nested",
                    },
                  },
                ],
              },
            ],
          },
        ]),
      );
      expect(result.html).toBe("<ul><li><ul><li>nested</li></ul></li></ul>");
    },
  );

  it("drops whitespace-only Offprint list text but preserves children", () => {
    const result = convert(
      offprint([
        {
          $type: "app.offprint.block.bulletList",
          children: [
            { content: { plaintext: " \n" } },
            {
              content: { plaintext: " \n" },
              children: [{ content: { plaintext: "nested" } }],
            },
          ],
        },
      ]),
    );
    expect(result.html).toBe("<ul><li><ul><li>nested</li></ul></li></ul>");
  });

  it.each([
    { $type: "app.offprint.content", items: [null, offprintText("kept"), {}] },
    { $type: "blog.pckt.content", items: [null, pcktText("kept"), {}] },
    {
      $type: "pub.leaflet.content",
      pages: [
        null,
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: [
            null,
            { block: { $type: "pub.leaflet.blocks.text", plaintext: "kept" } },
            {},
          ],
        },
      ],
    },
  ])("keeps valid blocks in $type", (content) => {
    expect(convert(content).html).toBe("<p>kept</p>");
  });

  it.each([false, true])(
    "recovers Pckt blob entries with wrapped=%s",
    async (wrapped) => {
      const items = [null, pcktText("from blob"), {}];
      const result = await convertDocumentContent(
        {
          content: {
            $type: "blog.pckt.content",
            blob: { ref: { $link: "bafyitems" }, mimeType: "application/json" },
          },
        },
        {
          did,
          loadBlob: stubBlobLoader({ bafyitems: wrapped ? { items } : items }),
        },
      );
      expect(result?.html).toBe("<p>from blob</p>");
    },
  );

  it("keeps valid quote children in both block formats", () => {
    expect(
      convert(
        offprint([
          {
            $type: "app.offprint.block.blockquote",
            content: [null, offprintText("quote")],
          },
        ]),
      ).html,
    ).toBe("<blockquote><p>quote</p></blockquote>");
    expect(
      convert(
        pckt([
          {
            $type: "blog.pckt.block.blockquote",
            content: [null, pcktText("quote")],
          },
        ]),
      ).html,
    ).toBe("<blockquote><p>quote</p></blockquote>");
  });

  it("keeps valid Pckt list children, table rows, and cells", () => {
    const result = convert(
      pckt([
        {
          $type: "blog.pckt.block.bulletList",
          content: [
            null,
            {
              $type: "blog.pckt.block.listItem",
              content: [null, pcktText("item")],
            },
          ],
        },
        {
          $type: "blog.pckt.block.table",
          content: [
            null,
            {
              content: [
                null,
                {
                  $type: "blog.pckt.block.tableCell",
                  content: [null, pcktText("cell")],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(result.html).toBe(
      "<ul><li>item</li></ul><table><tbody><tr><td>cell</td></tr></tbody></table>",
    );
  });

  it("keeps text and valid formatting beside malformed annotations", () => {
    const result = convert(
      offprint([
        {
          ...offprintText("readable"),
          facets: [
            null,
            {
              index: { byteStart: 0, byteEnd: 4 },
              features: [null, { $type: "x#bold" }],
            },
            { index: "invalid", features: [] },
          ],
        },
        { ...offprintText("plain"), facets: "invalid" },
      ]),
    );
    expect(result.html).toBe("<p><strong>read</strong>able</p><p>plain</p>");
  });
});

describe("Pckt block boundaries", () => {
  it("records emitted paragraphs in source order, excluding quoted paragraphs", () => {
    const list = {
      $type: "blog.pckt.block.bulletList",
      content: [
        {
          $type: "blog.pckt.block.listItem",
          content: [
            pcktText("first"),
            {
              $type: "blog.pckt.block.bulletList",
              content: [
                {
                  $type: "blog.pckt.block.listItem",
                  content: [
                    pcktText("nested first"),
                    pcktText("nested second"),
                  ],
                },
              ],
            },
            pcktText("second"),
          ],
        },
      ],
    };
    expect(convert(pckt([list, pcktText("later")])).firstParagraph).toBe(
      "first",
    );
    expect(
      convert(
        pckt([
          { $type: "blog.pckt.block.blockquote", content: [list] },
          pcktText("later"),
        ]),
      ).firstParagraph,
    ).toBe("later");
  });

  it.each(["bulletList", "taskList", "table"])(
    "preserves paragraphs within %s",
    (kind) => {
      const text = [pcktText("First paragraph"), pcktText("Second paragraph")];
      const content =
        kind === "table"
          ? [
              {
                content: [
                  { $type: "blog.pckt.block.tableCell", content: text },
                ],
              },
            ]
          : [
              {
                $type:
                  kind === "taskList"
                    ? "blog.pckt.block.taskItem"
                    : "blog.pckt.block.listItem",
                checked: true,
                content: text,
              },
            ];
      expect(
        convert(pckt([{ $type: `blog.pckt.block.${kind}`, content }])).html,
      ).toContain("<p>First paragraph</p><p>Second paragraph</p>");
    },
  );

  it("preserves text before and after nested lists without empty paragraphs", () => {
    const html = convert(
      pckt([
        {
          $type: "blog.pckt.block.bulletList",
          content: [
            {
              $type: "blog.pckt.block.listItem",
              content: [
                pcktText("before"),
                pcktText(" "),
                {
                  $type: "blog.pckt.block.bulletList",
                  content: [
                    {
                      $type: "blog.pckt.block.listItem",
                      content: [pcktText("nested")],
                    },
                  ],
                },
                pcktText("after"),
              ],
            },
          ],
        },
      ]),
    ).html;
    expect(html).toBe(
      "<ul><li><p>before</p><ul><li>nested</li></ul><p>after</p></li></ul>",
    );
  });

  it.each([2.5, 1e21, -1, 0, 1])(
    "drops invalid or default spans %s without dropping the cell",
    (span) => {
      const html = convert(
        pckt([
          {
            $type: "blog.pckt.block.table",
            content: [
              {
                content: [
                  {
                    $type: "blog.pckt.block.tableCell",
                    colspan: span,
                    rowspan: span,
                    content: [pcktText("cell")],
                  },
                ],
              },
            ],
          },
        ]),
      ).html;
      expect(html).toBe("<table><tbody><tr><td>cell</td></tr></tbody></table>");
    },
  );
});

describe("embedded HTML fallbacks", () => {
  it("replaces a deeply nested HTML block while preserving following content", () => {
    const html =
      "<div>".repeat(3000) + "<p>too deep</p>" + "</div>".repeat(3000);
    const result = convert(
      leaflet([
        { $type: "pub.leaflet.blocks.html", html },
        { $type: "pub.leaflet.blocks.text", plaintext: "readable sibling" },
      ]),
    );
    expect(result.html).toBe(
      `<div data-serial-embed="interactive"><p>${INTERACTIVE_PLACEHOLDER_TEXT}</p></div><p>readable sibling</p>`,
    );
    expect(result.firstParagraph).toBe("readable sibling");
    expect(result.firstImageUrl).toBeNull();
  });

  it.each(["html", "iframe"])(
    "derives %s metadata from surviving article content",
    (kind) => {
      const result = convert(
        leaflet([
          {
            $type: `pub.leaflet.blocks.${kind}`,
            html:
              "<script>bad</script><aside><p>aside</p></aside><blockquote><p>quoted</p></blockquote>" +
              "<p> </p><p>Opening <strong>paragraph</strong><br>continued &amp; readable</p>" +
              '<img src="javascript:bad"><img src="/relative"><img src="https://user:pass@example.com/x">' +
              '<img src="https://example.com/cover.jpg">',
          },
        ]),
      );
      expect(result.firstParagraph).toBe(
        "Opening paragraph\ncontinued & readable",
      );
      expect(result.firstImageUrl).toBe("https://example.com/cover.jpg");
    },
  );

  it("preserves the first fallback across native and HTML blocks", () => {
    const result = convert(
      leaflet([
        { $type: "pub.leaflet.blocks.text", plaintext: "native first" },
        {
          $type: "pub.leaflet.blocks.html",
          html: '<p>html later</p><img src="https://example.com/first.jpg">',
        },
        {
          $type: "pub.leaflet.blocks.image",
          image: { ref: { $link: "bafylater" }, mimeType: "image/png" },
        },
      ]),
    );
    expect(result.firstParagraph).toBe("native first");
    expect(result.firstImageUrl).toBe("https://example.com/first.jpg");
  });
});

describe("facet content preservation", () => {
  it.each([0, 1])(
    "preserves U+FEFF at the start of segment %s",
    (prefixLength) => {
      const prefix = "a".repeat(prefixLength);
      expect(
        renderRichText({
          plaintext: `${prefix}\uFEFFb`,
          facets: [
            {
              index: { byteStart: prefixLength, byteEnd: prefixLength + 3 },
              features: [{ $type: "x#bold" }],
            },
          ],
        }),
      ).toBe(`${prefix}<strong>\uFEFF</strong>b`);
    },
  );

  it("bounds duplicate formatting depth without dropping footnote markers", () => {
    const facets = Array.from({ length: 2000 }, () => ({
      index: { byteStart: 0, byteEnd: 1 },
      features: [{ $type: "x#bold" }],
    }));
    const result = convert(
      offprint([
        {
          ...offprintText("x"),
          facets: [
            ...facets,
            {
              index: { byteStart: 0, byteEnd: 1 },
              features: [
                {
                  $type: "x#footnote",
                  footnoteId: "note",
                  contentPlaintext: "kept",
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(result.html).toBe(
      "<p><strong>x</strong><sup>[1]</sup></p><section><ol><li>kept</li></ol></section>",
    );
  });
});

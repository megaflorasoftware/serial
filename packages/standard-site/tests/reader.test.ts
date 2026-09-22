import { describe, expect, it } from "vitest";
import {
  boundReaderDocument,
  calloutTint,
  deriveReaderDocument,
  deriveResolvedContent,
  MAX_BLOCK_NESTING_DEPTH,
  parseYouTubeReference,
  readerDocumentBytes,
  summarizeReaderDocument,
} from "../src";
import type { ReaderBlock, ReaderDocument } from "../src";
import { buildBlueskyCdnImageUrl } from "../src/uris";
import {
  FIXTURE_DOCUMENTS,
  fixtureReaderBody,
  kinds,
  leaflet,
  loadDocumentFixture,
  offprint,
  pckt,
  typedDocument,
} from "./fixtures";
import type { FixtureName } from "./fixtures";

const did = "did:plc:example";

function derive(content: unknown): ReaderDocument {
  const document = deriveResolvedContent(content, did);
  if (!document) throw new Error("content did not derive");
  return document;
}

function deriveFixture(name: FixtureName) {
  const { did: fixtureDid } = loadDocumentFixture(name);
  const document = deriveReaderDocument(fixtureReaderBody(name), fixtureDid);
  if (!document) throw new Error(`Fixture ${name} did not derive`);
  return { document, did: fixtureDid };
}

function find<K extends ReaderBlock["kind"]>(
  blocks: ReaderBlock[],
  kind: K,
): Extract<ReaderBlock, { kind: K }>[] {
  return blocks.filter(
    (block): block is Extract<ReaderBlock, { kind: K }> => block.kind === kind,
  );
}

describe("real documents", () => {
  it.each(FIXTURE_DOCUMENTS)("%s matches its snapshot", async (name) => {
    const { document } = deriveFixture(name);
    await expect(
      JSON.stringify(typedDocument(document), null, 2),
    ).toMatchFileSnapshot(`./__snapshots__/${name}.reader.json`);
  });

  it.each(FIXTURE_DOCUMENTS)("%s keeps every block's source", (name) => {
    const { document } = deriveFixture(name);
    const visit = (blocks: ReaderBlock[]) => {
      for (const block of blocks) {
        if (block.kind !== "notice" || block.reason !== "truncated") {
          expect(block.source, block.kind).toBeDefined();
          expect(block.source, block.kind).not.toBeNull();
        }
        if (block.kind === "quotation") visit(block.children);
        if (block.kind === "list")
          for (const item of block.items) visit(item.content);
      }
    };
    visit(document.blocks);
    expect(document.truncated).toBe(false);
  });

  it("carries Leaflet wrapper alignment, image width and aspect ratio", () => {
    const { document } = deriveFixture("leaflet-network-punk");
    const [image] = find(document.blocks, "image");
    expect(image).toMatchObject({
      align: "center",
      image: { aspectRatio: { width: 256, height: 256 }, width: null },
    });
    const [embed] = find(document.blocks, "embed");
    expect(embed).toMatchObject({
      youtube: { videoId: "d-H1nzWHLoI" },
      height: 300,
    });
    const sized = find(
      deriveFixture("leaflet-what-is-the-atmosphere").document.blocks,
      "image",
    );
    expect(sized[0]?.image.width).toEqual({ value: 624, unit: "px" });
  });

  it("carries Offprint image alignment, percent width, callout color and highlight", () => {
    const { document } = deriveFixture("offprint-interactive-transcripts");
    const images = find(document.blocks, "image");
    expect(images[1]).toMatchObject({
      align: "center",
      image: {
        width: { value: 40, unit: "%" },
        aspectRatio: { width: 1000, height: 1000 },
      },
    });
    const [callout] = find(document.blocks, "callout");
    expect(callout).toMatchObject({
      emoji: "🪿",
      color: "rgb(59 130 246 / 0.2)",
      tint: "rgb(59 130 246 / 0.2)",
    });
    const highlighted = find(document.blocks, "paragraph")
      .flatMap((block) => block.content)
      .find((inline) => inline.kind === "text" && inline.marks.highlight);
    expect(highlighted).toMatchObject({
      marks: { highlight: { color: expect.any(String) } },
    });
  });

  it("carries the Offprint grid mode and rows", () => {
    const { document } = deriveFixture("offprint-nyc-community-day");
    const [group] = find(document.blocks, "imageGroup");
    expect(group).toMatchObject({
      layout: { mode: "grid", rows: 2, ratio: "mosaic" },
    });
    expect(group?.images).toHaveLength(6);
    expect(group?.images[0]?.aspectRatio).toEqual({
      width: 1900,
      height: 1425,
    });
    const button = find(document.blocks, "linkCard").at(-1);
    expect(button).toMatchObject({
      title: expect.stringContaining("tickets"),
      align: "center",
    });
  });

  it("carries pckt image alignment and numeric-string width", () => {
    const { document } = deriveFixture("pckt-cant-stop-crediting");
    const [image] = find(document.blocks, "image");
    expect(image).toMatchObject({
      align: "center",
      image: {
        width: { value: 500, unit: "px" },
        alt: expect.stringContaining("can't stop"),
      },
    });
    expect(image?.source).toMatchObject({
      attrs: { placeholder: expect.any(String) },
    });
  });

  it("derives an authored HTML block with its height", () => {
    const { document } = deriveFixture("leaflet-what-is-the-atmosphere");
    const [html] = find(document.blocks, "html");
    expect(html?.height).toBe(243);
    expect(html?.html).toContain("<style>");
    // Its Bluesky embed resolves into a social card from the fixture snapshots.
    const posts = find(document.blocks, "socialPost").map((block) => block.post);
    expect(posts).toMatchObject([
      {
        platform: "bluesky",
        author: { handle: "pckt.blog", name: "pckt.blog" },
        video: {
          thumbnailUrl: expect.stringContaining("video.bsky.app"),
          aspectRatio: { width: 1660, height: 1080 },
        },
      },
    ]);
  });

  it("shows the notice for a poll and keeps the code block", () => {
    expect(
      kinds(deriveFixture("leaflet-poll-block").document.blocks),
    ).toContain("notice");
    const [code] = find(
      deriveFixture("leaflet-reader-code-block").document.blocks,
      "code",
    );
    expect(code?.code).toContain("SELECT uri");
    expect(code?.language).toBeNull();
  });

  it("summarizes the first paragraph outside quotations and the first image", () => {
    const { document, did: fixtureDid } = deriveFixture(
      "pckt-science-vs-vegetable-faces",
    );
    const summary = summarizeReaderDocument(document);
    expect(summary.firstParagraph).toMatch(/\S/);
    expect(summary.firstImageUrl).toContain(`/${fixtureDid}/`);
  });
});

describe("leaflet blocks", () => {
  it("renders headings, quotations, lists of both kinds, checklists, code, math and dividers", () => {
    const document = derive(
      leaflet([
        { $type: "pub.leaflet.blocks.header", level: 3, plaintext: "Title" },
        { $type: "pub.leaflet.blocks.blockquote", plaintext: "Quoted" },
        {
          $type: "pub.leaflet.blocks.orderedList",
          startIndex: 4,
          children: [
            {
              content: { $type: "pub.leaflet.blocks.text", plaintext: "one" },
              unorderedListChildren: {
                children: [
                  {
                    content: {
                      $type: "pub.leaflet.blocks.header",
                      plaintext: "two",
                    },
                    checked: true,
                  },
                ],
              },
            },
            { content: { $type: "pub.leaflet.blocks.text", plaintext: "  " } },
          ],
        },
        {
          $type: "pub.leaflet.blocks.code",
          plaintext: "x = 1",
          language: "python",
        },
        { $type: "pub.leaflet.blocks.math", tex: "e = mc^2" },
        { $type: "pub.leaflet.blocks.horizontalRule" },
        { $type: "pub.leaflet.blocks.page", id: "child" },
        { $type: "pub.leaflet.blocks.signup" },
        { $type: "pub.leaflet.blocks.postsList" },
      ]),
    );
    expect(kinds(document.blocks)).toEqual([
      "heading",
      "quotation",
      "paragraph",
      "list",
      "paragraph",
      "list",
      "paragraph",
      "code",
      "math",
      "divider",
    ]);
    expect(document.blocks[0]).toMatchObject({ level: 3 });
    const list = find(document.blocks, "list")[0]!;
    expect(list.start).toBe(4);
    expect(list.items).toHaveLength(1);
    const nested = find(list.items[0]!.content, "list")[0]!;
    expect(nested.ordered).toBe(false);
    expect(nested.items[0]).toMatchObject({
      checked: true,
      content: [{ kind: "paragraph", content: [{ marks: { bold: true } }] }],
    });
    expect(find(document.blocks, "code")[0]).toMatchObject({
      language: "python",
    });
  });

  it("keeps text and valid formatting beside malformed facets", () => {
    const document = derive(
      leaflet([
        {
          $type: "pub.leaflet.blocks.text",
          plaintext: "keep me",
          facets: [
            null,
            { index: "invalid", features: [{ $type: "x#bold" }] },
            { index: { byteStart: 0, byteEnd: 4 }, features: "invalid" },
            {
              index: { byteStart: 5, byteEnd: 7 },
              features: [null, { $type: "x#italic" }],
            },
          ],
        },
        {
          $type: "pub.leaflet.blocks.text",
          plaintext: "plain",
          facets: "invalid",
        },
      ]),
    );
    expect(document.blocks).toMatchObject([
      {
        kind: "paragraph",
        content: [
          { text: "keep ", marks: {} },
          { text: "me", marks: { italic: true } },
        ],
      },
      { kind: "paragraph", content: [{ text: "plain", marks: {} }] },
    ]);
  });

  it("renders website blocks as record previews or link cards and buttons as cards", () => {
    const record = `at://${did}/site.standard.document/other`;
    const document = derive(
      leaflet([
        { $type: "pub.leaflet.blocks.website", src: record },
        {
          $type: "pub.leaflet.blocks.website",
          src: "https://example.com",
          title: "Example",
          description: "A site",
          previewImage: {
            ref: { $link: "bafypreview" },
            mimeType: "image/png",
          },
        },
        {
          $type: "pub.leaflet.blocks.button",
          url: "https://example.com/go",
          text: "Go",
        },
        {
          $type: "pub.leaflet.blocks.button",
          url: "javascript:alert(1)",
          text: "Bad",
        },
        {
          $type: "pub.leaflet.blocks.bskyPost",
          postRef: {
            uri: "at://did:plc:x/app.bsky.feed.post/abc",
            cid: "bafy",
          },
        },
      ]),
    );
    expect(kinds(document.blocks)).toEqual([
      "recordPreview",
      "linkCard",
      "linkCard",
      "recordPreview",
    ]);
    expect(document.blocks[1]).toMatchObject({
      href: "https://example.com/",
      title: "Example",
      description: "A site",
      imageUrl: buildBlueskyCdnImageUrl(did, "bafypreview"),
    });
    expect(document.blocks[3]).toMatchObject({
      card: {
        url: "https://bsky.app/profile/did:plc:x/post/abc",
        title: "Post on Bluesky",
      },
    });
  });

  it("derives iframes as embeds or html blocks and the delimiter as a notice", () => {
    const document = derive(
      leaflet([
        {
          $type: "pub.leaflet.blocks.iframe",
          url: "https://youtu.be/d-H1nzWHLoI?t=30s",
        },
        {
          $type: "pub.leaflet.blocks.iframe",
          url: "https://codepen.io/pen",
          height: 9000,
        },
        { $type: "pub.leaflet.blocks.iframe", html: "<b>hi</b>", height: 100 },
        {
          $type: "pub.leaflet.blocks.html",
          html: "<p>page</p>",
          aspectRatio: { width: 16, height: 9 },
        },
        { $type: "pub.leaflet.blocks.iframe" },
        { $type: "pub.leaflet.blocks.membersOnlyDelimiter", audience: "paid" },
        {
          $type: "pub.leaflet.blocks.poll",
          pollRef: { uri: "at://x/y/z", cid: "c" },
        },
        { $type: "pub.leaflet.blocks.mystery", plaintext: "still text" },
        { $type: "pub.leaflet.blocks.mystery" },
      ]),
    );
    expect(kinds(document.blocks)).toEqual([
      "embed",
      "embed",
      "html",
      "html",
      "notice",
      "notice",
      "notice",
      "paragraph",
      "notice",
    ]);
    expect(document.blocks[0]).toMatchObject({
      youtube: { videoId: "d-H1nzWHLoI", start: "30" },
    });
    expect(document.blocks[1]).toMatchObject({ youtube: null, height: null });
    expect(document.blocks[2]).toMatchObject({
      html: "<b>hi</b>",
      height: 100,
    });
    expect(document.blocks[3]).toMatchObject({
      aspectRatio: { width: 16, height: 9 },
    });
    expect(
      find(document.blocks, "notice").map((notice) => notice.reason),
    ).toEqual(["unsupported", "membersOnly", "unsupported", "unsupported"]);
  });

  it("renders galleries as stacked image groups, dropping malformed entries", () => {
    const document = derive(
      leaflet([
        {
          $type: "pub.leaflet.blocks.imageGallery",
          images: [
            {
              image: { ref: { $link: "bafyone" }, mimeType: "image/png" },
              alt: "One",
            },
            { image: "nope" },
            { image: { ref: { $link: "bafytwo" }, mimeType: "image/png" } },
          ],
        },
        {
          $type: "pub.leaflet.blocks.imageGallery",
          images: [{ image: "nope" }],
        },
      ]),
    );
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]).toMatchObject({
      kind: "imageGroup",
      layout: { mode: "stack" },
      images: [{ alt: "One" }, { alt: "" }],
    });
  });

  it("shows one notice per canvas page and drops malformed pages", () => {
    const document = derive({
      $type: "pub.leaflet.content",
      pages: [
        { $type: "pub.leaflet.pages.canvas", blocks: [] },
        "not a page",
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: [
            { block: { $type: "pub.leaflet.blocks.text", plaintext: "kept" } },
          ],
        },
      ],
    });
    expect(kinds(document.blocks)).toEqual(["notice", "paragraph"]);
    expect(document.blocks[0]).toMatchObject({ reason: "canvas" });
  });

  it("turns an over-deep subtree into one notice and keeps its ancestors", () => {
    let item: Record<string, unknown> = {
      content: { $type: "pub.leaflet.blocks.text", plaintext: "deepest" },
    };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH + 2; depth += 1) {
      item = {
        content: {
          $type: "pub.leaflet.blocks.text",
          plaintext: `level ${depth}`,
        },
        children: [item],
      };
    }
    const document = derive(
      leaflet([
        { $type: "pub.leaflet.blocks.unorderedList", children: [item] },
      ]),
    );
    const flat = kinds(document.blocks);
    expect(flat[0]).toBe("list");
    expect(flat.at(-1)).toBe("notice");
    expect(flat.filter((kind) => kind === "list")).toHaveLength(
      MAX_BLOCK_NESTING_DEPTH,
    );
    expect(document.truncated).toBe(false);
  });
});

describe("pckt blocks", () => {
  it("renders tables, task lists, hard breaks, mentions, and external images", () => {
    const text = (plaintext: string) => ({
      $type: "blog.pckt.block.text",
      plaintext,
    });
    const document = derive(
      pckt([
        {
          $type: "blog.pckt.block.table",
          content: [
            {
              content: [
                {
                  $type: "blog.pckt.block.tableHeader#main",
                  content: [text("h")],
                  colspan: 2,
                },
              ],
            },
            {
              content: [
                {
                  $type: "blog.pckt.block.tableCell",
                  content: [text("a")],
                  rowspan: 1,
                },
                {
                  $type: "blog.pckt.block.tableCell#main",
                  content: [text("b")],
                },
              ],
            },
          ],
        },
        {
          $type: "blog.pckt.block.taskList",
          content: [
            {
              $type: "blog.pckt.block.taskItem",
              checked: true,
              content: [text("done")],
            },
            { $type: "blog.pckt.block.taskItem", content: [text("")] },
          ],
        },
        { $type: "blog.pckt.block.hardBreak" },
        { $type: "blog.pckt.block.mention", did: "did:plc:abc", handle: "abc" },
        {
          $type: "blog.pckt.block.image",
          attrs: {
            src: "https://example.com/pic.png",
            alt: "Pic",
            title: "Hover",
            align: "right",
            width: "300px",
          },
        },
        {
          $type: "blog.pckt.block.image",
          attrs: { src: "javascript:alert(1)" },
        },
        {
          $type: "blog.pckt.block.orderedList",
          start: 3,
          content: [
            { $type: "blog.pckt.block.listItem", content: [text("three")] },
          ],
        },
        {
          $type: "blog.pckt.block.iframe",
          url: "https://open.spotify.com/embed/x",
          height: 152,
        },
      ]),
    );
    expect(kinds(document.blocks)).toEqual([
      "table",
      "paragraph",
      "paragraph",
      "paragraph",
      "list",
      "paragraph",
      "break",
      "paragraph",
      "image",
      "list",
      "paragraph",
      "embed",
    ]);
    const [table] = find(document.blocks, "table");
    expect(table?.rows[0]?.[0]).toMatchObject({
      header: true,
      colspan: 2,
      rowspan: null,
    });
    expect(table?.rows[1]?.[0]).toMatchObject({ header: false, rowspan: null });
    const [tasks, ordered] = find(document.blocks, "list");
    expect(tasks?.items).toEqual([expect.objectContaining({ checked: true })]);
    expect(ordered).toMatchObject({ ordered: true, start: 3 });
    expect(find(document.blocks, "paragraph")[0]).toMatchObject({
      content: [
        {
          text: "@abc",
          link: { href: "https://bsky.app/profile/did:plc:abc" },
        },
      ],
    });
    expect(find(document.blocks, "image")[0]).toMatchObject({
      align: "right",
      image: {
        url: "https://example.com/pic.png",
        alt: "Pic",
        title: "Hover",
        width: { value: 300, unit: "px" },
      },
    });
    expect(find(document.blocks, "embed")[0]).toMatchObject({
      href: "https://open.spotify.com/embed/x",
      height: 152,
      youtube: null,
    });
  });

  it("turns an over-deep pckt quotation into one notice and keeps its ancestors", () => {
    let quote: Record<string, unknown> = {
      $type: "blog.pckt.block.text",
      plaintext: "deepest",
    };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH + 2; depth += 1) {
      quote = { $type: "blog.pckt.block.blockquote", content: [quote] };
    }
    const document = derive(
      pckt([quote, { $type: "blog.pckt.block.text", plaintext: "after" }]),
    );
    const flat = kinds(document.blocks);
    // The quotation at the limit still renders; its children become the notice.
    expect(flat.filter((kind) => kind === "quotation")).toHaveLength(
      MAX_BLOCK_NESTING_DEPTH + 1,
    );
    expect(flat.filter((kind) => kind === "notice")).toHaveLength(1);
    expect(flat.at(-1)).toBe("paragraph");
  });

  it("keeps quotations out of the summary and blob images on the CDN", () => {
    const document = derive(
      pckt([
        {
          $type: "blog.pckt.block.blockquote",
          content: [{ $type: "blog.pckt.block.text", plaintext: "quoted" }],
        },
        { $type: "blog.pckt.block.text", plaintext: "first real paragraph" },
        {
          $type: "blog.pckt.block.image",
          attrs: {
            src: "blob:bafyimage",
            blob: { ref: { $link: "bafyimage" }, mimeType: "image/png" },
          },
        },
      ]),
    );
    expect(summarizeReaderDocument(document)).toEqual({
      firstParagraph: "first real paragraph",
      firstImageUrl: buildBlueskyCdnImageUrl(did, "bafyimage"),
    });
  });
});

describe("offprint blocks", () => {
  it("renders callouts, nested quotations, task lists, captions, carousels and unknown blocks", () => {
    const document = derive(
      offprint([
        {
          $type: "app.offprint.block.callout",
          plaintext: "Note",
          emoji: "⚠️",
          color: "url(x)",
        },
        { $type: "app.offprint.block.callout", plaintext: "Plain" },
        {
          $type: "app.offprint.block.blockquote",
          content: [
            {
              $type: "app.offprint.block.heading",
              level: 2,
              plaintext: "Quoted heading",
              textAlign: "center",
            },
          ],
        },
        {
          $type: "app.offprint.block.taskList",
          children: [
            { content: { plaintext: "done" }, checked: true },
            { content: { plaintext: "todo" } },
          ],
        },
        {
          $type: "app.offprint.block.image",
          image: { ref: { $link: "bafyone" }, mimeType: "image/png" },
          caption: "Caption text",
          captionFacets: [
            {
              index: { byteStart: 0, byteEnd: 7 },
              features: [{ $type: "x#bold" }],
            },
          ],
          width: "auto",
        },
        {
          $type: "app.offprint.block.imageCarousel",
          images: [
            { blob: { ref: { $link: "bafytwo" }, mimeType: "image/png" } },
          ],
          caption: "Carousel",
        },
        { $type: "app.offprint.block.component", name: "Widget" },
        {
          $type: "app.offprint.block.text",
          plaintext: "Justified",
          textAlign: "justify",
        },
        {
          $type: "app.offprint.block.webEmbed",
          href: "https://example.com/page",
          embedUrl: "https://example.com/embed",
          embedHeight: 400,
          alignment: "center",
        },
      ]),
    );
    expect(kinds(document.blocks)).toEqual([
      "callout",
      "callout",
      "quotation",
      "heading",
      "list",
      "paragraph",
      "paragraph",
      "image",
      "imageGroup",
      "notice",
      "paragraph",
      "embed",
    ]);
    expect(document.blocks[0]).toMatchObject({
      emoji: "⚠️",
      color: "url(x)",
      tint: null,
    });
    expect(document.blocks[1]).toMatchObject({ emoji: null, tint: null });
    const [quotation] = find(document.blocks, "quotation");
    expect(quotation?.children[0]).toMatchObject({
      kind: "heading",
      level: 2,
      align: "center",
    });
    const [tasks] = find(document.blocks, "list");
    expect(tasks?.items.map((item) => item.checked)).toEqual([true, false]);
    const [image] = find(document.blocks, "image");
    expect(image).toMatchObject({
      image: { width: null },
      caption: [{ text: "Caption", marks: { bold: true } }, { text: " text" }],
    });
    const [carousel] = find(document.blocks, "imageGroup");
    expect(carousel).toMatchObject({
      layout: { mode: "stack" },
      caption: [{ text: "Carousel" }],
    });
    expect(find(document.blocks, "paragraph").at(-1)).toMatchObject({
      align: "justify",
    });
    expect(find(document.blocks, "embed")[0]).toMatchObject({
      href: "https://example.com/page",
      embedUrl: "https://example.com/embed",
      height: 400,
      align: "center",
    });
    expect(summarizeReaderDocument(document).firstParagraph).toBe("done");
  });

  it("turns an over-deep Offprint list into one notice", () => {
    let item: Record<string, unknown> = { content: { plaintext: "deepest" } };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH + 2; depth += 1) {
      item = { content: { plaintext: `level ${depth}` }, children: [item] };
    }
    const document = derive(
      offprint([{ $type: "app.offprint.block.bulletList", children: [item] }]),
    );
    const flat = kinds(document.blocks);
    expect(flat.filter((kind) => kind === "list")).toHaveLength(
      MAX_BLOCK_NESTING_DEPTH,
    );
    expect(flat.at(-1)).toBe("notice");
  });

  it("drops whitespace-only Offprint list text but keeps its children", () => {
    const [list] = find(
      derive(
        offprint([
          {
            $type: "app.offprint.block.bulletList",
            children: [
              {
                content: { plaintext: "   " },
                children: [{ content: { plaintext: "child" } }],
              },
              { content: { plaintext: "  " } },
            ],
          },
        ]),
      ).blocks,
      "list",
    );
    expect(list?.items).toHaveLength(1);
    expect(kinds(list!.items[0]!.content)).toEqual(["list", "paragraph"]);
  });

  it("keeps an image whose caption facets are malformed", () => {
    const [image] = find(
      derive(
        offprint([
          {
            $type: "app.offprint.block.image",
            image: { ref: { $link: "bafyone" }, mimeType: "image/png" },
            caption: "Caption",
            captionFacets: "invalid",
          },
        ]),
      ).blocks,
      "image",
    );
    expect(image?.caption).toEqual([
      { kind: "text", text: "Caption", marks: {}, link: null },
    ]);
  });

  it("drops bad pckt gallery entries and keeps the rest", () => {
    const galleryUri = "at://did:plc:bob/blog.pckt.gallery/one";
    const document = deriveResolvedContent(
      pckt([{ $type: "blog.pckt.block.gallery", ref: galleryUri }]),
      did,
      () => ({
        uri: galleryUri,
        cid: "bafy",
        value: {
          images: [
            null,
            { src: 42 },
            { src: "javascript:alert(1)" },
            { src: "https://example.com/ok.png" },
          ],
        },
      }),
    );
    expect(document?.blocks[0]).toMatchObject({
      kind: "imageGroup",
      images: [{ url: "https://example.com/ok.png" }],
    });
  });

  it("derives grids with their layout and drops images without a blob", () => {
    const [grid] = find(
      derive(
        offprint([
          {
            $type: "app.offprint.block.imageGrid",
            gridRows: 2,
            aspectRatio: "square",
            images: [
              { image: { ref: { $link: "bafyone" }, mimeType: "image/png" } },
              { alt: "no blob" },
              {
                blob: { ref: { $link: "bafytwo" }, mimeType: "image/png" },
                aspectRatio: { width: 4, height: 3 },
              },
            ],
          },
          { $type: "app.offprint.block.imageGrid", images: [] },
        ]),
      ).blocks,
      "imageGroup",
    );
    expect(grid).toMatchObject({
      layout: { mode: "grid", rows: 2, ratio: "square" },
      images: [{ aspectRatio: null }, { aspectRatio: { width: 4, height: 3 } }],
    });
  });
});

describe("bounds", () => {
  const paragraph = (text: string): ReaderBlock => ({
    kind: "paragraph",
    source: { $type: "x", plaintext: text },
    align: null,
    content: [{ kind: "text", text, marks: {}, link: null }],
  });

  it("cuts at the block boundary crossing the byte limit and appends the notice", () => {
    const blocks = Array.from({ length: 10 }, (_, index) =>
      paragraph(`p${index}`),
    );
    const document = boundReaderDocument(blocks, [], { bytes: 400 });
    expect(document.truncated).toBe(true);
    expect(document.blocks.at(-1)).toMatchObject({
      kind: "notice",
      reason: "truncated",
    });
    expect(document.blocks.length).toBeLessThan(blocks.length);
    expect(readerDocumentBytes(document)).toBeLessThan(600);
  });

  it("counts footnote text toward the byte limit", () => {
    const blocks = [paragraph("short")];
    const footnotes = [
      {
        number: 1,
        content: [
          {
            kind: "text" as const,
            text: "x".repeat(600),
            marks: {},
            link: null,
          },
        ],
      },
    ];
    expect(
      boundReaderDocument(blocks, footnotes, { bytes: 400 }).truncated,
    ).toBe(true);
    expect(boundReaderDocument(blocks, [], { bytes: 400 }).truncated).toBe(
      false,
    );
  });

  it("counts nested blocks toward the block limit and drops orphaned footnotes", () => {
    const blocks: ReaderBlock[] = [
      paragraph("kept"),
      {
        kind: "paragraph",
        source: null,
        align: null,
        content: [
          { kind: "text", text: "cited", marks: {}, link: null },
          { kind: "footnote", number: 1 },
        ],
      },
      {
        kind: "list",
        source: null,
        align: null,
        ordered: false,
        start: null,
        items: [
          { content: [paragraph("a"), paragraph("b")], checked: null },
          { content: [paragraph("c")], checked: null },
        ],
      },
    ];
    const footnotes = [
      {
        number: 1,
        content: [
          { kind: "text" as const, text: "note", marks: {}, link: null },
        ],
      },
    ];
    expect(boundReaderDocument(blocks, footnotes, { blocks: 5 })).toMatchObject(
      {
        truncated: true,
        footnotes: [{ number: 1 }],
        blocks: [
          { kind: "paragraph" },
          { kind: "paragraph" },
          { kind: "notice" },
        ],
      },
    );
    expect(boundReaderDocument(blocks, footnotes, { blocks: 1 })).toMatchObject(
      {
        truncated: true,
        footnotes: [],
      },
    );
    expect(boundReaderDocument(blocks, footnotes, { blocks: 6 })).toMatchObject(
      {
        truncated: false,
        blocks: blocks,
      },
    );
  });
});

describe("helpers", () => {
  it("validates callout tints", () => {
    expect(calloutTint("#abc")).toBe("#abc");
    expect(calloutTint("rgb(59 130 246 / 0.2)")).toBe("rgb(59 130 246 / 0.2)");
    expect(calloutTint("hsla(10, 20%, 30%, 0.5)")).toBe(
      "hsla(10, 20%, 30%, 0.5)",
    );
    expect(calloutTint("Tomato")).toBe("tomato");
    expect(calloutTint("var(--x)")).toBeNull();
    expect(calloutTint("red; background: url(x)")).toBeNull();
    expect(calloutTint(null)).toBeNull();
  });

  it("reads start offsets from share and embed links", () => {
    expect(parseYouTubeReference("https://youtu.be/d-H1nzWHLoI?t=30s")).toEqual(
      {
        videoId: "d-H1nzWHLoI",
        start: "30",
      },
    );
    expect(
      parseYouTubeReference(
        "https://www.youtube.com/embed/d-H1nzWHLoI?start=12",
      ),
    ).toEqual({ videoId: "d-H1nzWHLoI", start: "12" });
    expect(parseYouTubeReference("https://vimeo.com/123")).toBeNull();
  });
});

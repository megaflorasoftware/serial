import { describe, expect, it } from "vitest";
import {
  convertDocumentContent,
  convertResolvedContent,
  INTERACTIVE_PLACEHOLDER_TEXT,
  parseYouTubeReference,
} from "../src/convert";
import { MAX_BLOCK_NESTING_DEPTH } from "../src/convert/shared";
import { sanitizeArticleHtml } from "../src/sanitize";
import { buildBlueskyCdnImageUrl } from "../src/uris";
import {
  FIXTURE_DOCUMENTS,
  loadDocumentFixture,
  rejectingBlobLoader,
  stubBlobLoader,
  leaflet,
  offprint,
  pckt,
} from "./fixtures";
import type { FixtureName } from "./fixtures";

const did = "did:plc:example";

async function convertFixture(name: FixtureName) {
  const { record, did: fixtureDid } = loadDocumentFixture(name);
  const converted = await convertDocumentContent(record.value, {
    did: fixtureDid,
    loadBlob: rejectingBlobLoader,
  });
  if (!converted) throw new Error(`Fixture ${name} did not convert`);
  return { converted, did: fixtureDid, record };
}

/** Converts without the final sanitizer pass so the fixed point is asserted on raw output. */
function convertRaw(content: unknown) {
  const converted = convertResolvedContent(content, did);
  if (!converted) throw new Error("content did not convert");
  return converted.html;
}

function expectFixedPoint(html: string) {
  expect(sanitizeArticleHtml(html)).toBe(html);
  expect(html).not.toMatch(/<(iframe|script|style)\b/);
}

function count(html: string, pattern: RegExp) {
  return html.match(pattern)?.length ?? 0;
}

describe("convertDocumentContent fixtures", () => {
  it.each(FIXTURE_DOCUMENTS)(
    "%s raw converter output is a sanitizer fixed point",
    (name) => {
      const { record, did: fixtureDid } = loadDocumentFixture(name);
      const converted = convertResolvedContent(
        record.value.content,
        fixtureDid,
      );
      expect(converted).not.toBeNull();
      expectFixedPoint(converted!.html);
    },
  );

  it.each(FIXTURE_DOCUMENTS)("%s matches its snapshot", async (name) => {
    const { converted } = await convertFixture(name);
    await expect(converted.html).toMatchFileSnapshot(
      `./__snapshots__/${name}.html`,
    );
  });

  it("renders leaflet text, headers, images, lists, link cards, and posts", async () => {
    const { converted, did: fixtureDid } = await convertFixture(
      "leaflet-montreal-recap",
    );
    expect(
      converted.html.startsWith(
        "<p>The ATProto community gathered in Montreal",
      ),
    ).toBe(true);
    // The source ends with an empty level-one header, which is dropped.
    expect(count(converted.html, /<h1>/g)).toBe(4);
    expect(count(converted.html, /<h2>/g)).toBe(6);
    expect(converted.html).not.toMatch(/<h[1-6]><\/h[1-6]>/);
    expect(converted.html).toContain(
      `<figure><img src="${buildBlueskyCdnImageUrl(fixtureDid, "bafkreie4phcb3tltjqhb2qws3rq72ipztoweb5ynjkdklr72iptdj5ine4")}" alt="Group of people`,
    );
    expect(converted.html).toContain(
      "<ul><li><strong>Using Microcosm for more things:</strong>",
    );
    expect(converted.html).toContain(
      '<p><a href="https://www.ietf.org/meeting/124/"><strong>IETF 124 Montreal</strong></a><br>Register today',
    );
    expect(converted.html).toContain(
      '<p><a href="https://bsky.app/profile/did:plc:2cxgdrgtsmrbqnjkwyplmp43/post/3m4ntigu7ak27"><strong>View post on Bluesky</strong></a></p>',
    );
    expect(
      converted.firstParagraph?.startsWith("The ATProto community gathered"),
    ).toBe(true);
    expect(converted.firstImageUrl).toBe(
      buildBlueskyCdnImageUrl(
        fixtureDid,
        "bafkreie4phcb3tltjqhb2qws3rq72ipztoweb5ynjkdklr72iptdj5ine4",
      ),
    );
  });

  it("renders a leaflet YouTube iframe as the youtube placeholder", async () => {
    const { converted, did: fixtureDid } = await convertFixture(
      "leaflet-network-punk",
    );
    expect(
      converted.html.startsWith(
        '<div data-serial-embed="youtube" data-video-id="d-H1nzWHLoI"><p><a href="https://www.youtube.com/watch?v=d-H1nzWHLoI">Watch on YouTube</a></p></div>',
      ),
    ).toBe(true);
    expect(converted.html).toContain("<blockquote><p>");
    expect(converted.html).toContain("<hr>");
    expect(converted.firstImageUrl).toBe(
      buildBlueskyCdnImageUrl(
        fixtureDid,
        "bafkreiefsccyzsc724jax75xxjhu7u2fic6b7pdzuoen33smejmrovsyiu",
      ),
    );
  });

  it("renders a legacy-site leaflet document with a non-YouTube iframe placeholder", async () => {
    const { converted } = await convertFixture("leaflet-legacy-site");
    expect(converted.html.startsWith("<h2>What is ATmosphereConf?</h2>")).toBe(
      true,
    );
    expect(converted.html).toContain(
      `<div data-serial-embed="interactive" data-href="https://tally.so/embed/zxNLd1?alignLeft=1&#x26;hideTitle=1&#x26;transparentBackground=1&#x26;dynamicHeight=1"><p><a href="https://tally.so/embed/zxNLd1?alignLeft=1&#x26;hideTitle=1&#x26;transparentBackground=1&#x26;dynamicHeight=1">${INTERACTIVE_PLACEHOLDER_TEXT}</a></p></div>`,
    );
    expect(converted.html).not.toContain('data-serial-embed="youtube"');
  });

  it("renders offprint callouts, mentions, highlights, lists, and images", async () => {
    const { converted, did: fixtureDid } = await convertFixture(
      "offprint-interactive-transcripts",
    );
    expect(converted.html).toContain(
      '<a href="https://bsky.app/profile/did:plc:wyr3q7n3wte7vhf5bnn4vazj">@maboa.bsky.social</a>',
    );
    expect(converted.html).toContain("<mark>");
    expect(converted.html).toContain(
      "<blockquote><p>🪿 The AtmosphereConf website is open source",
    );
    expect(converted.html).toContain("<h2>Code and Libraries</h2>");
    expect(count(converted.html, /<ul>/g)).toBe(2);
    expect(converted.html).toContain(
      `<figure><img src="${buildBlueskyCdnImageUrl(fixtureDid, "bafkreifqczfh25syz3yywxr5tbcp4amtwmnqr4lnplmcshkp7w2mdu25wq")}" alt=""></figure>`,
    );
    expect(converted.html.endsWith("</p>")).toBe(true);
    expect(converted.html).not.toContain("<p></p>");
  });

  it("renders an offprint web embed as a youtube placeholder", async () => {
    const embed = await convertFixture("offprint-bluesky-and-did-plc");
    expect(embed.converted.html).toContain(
      '<div data-serial-embed="youtube" data-video-id="m9AVUAUDC2A"><p><a href="https://www.youtube.com/watch?v=m9AVUAUDC2A">Watch on YouTube</a></p></div>',
    );
    expect(embed.converted.html).toContain(
      "<blockquote><p>💡 Figure out how to upload",
    );
  });

  it("renders offprint bookmarks, posts, and buttons as link cards", async () => {
    const awards = await convertFixture("offprint-open-social-awards");
    expect(awards.converted.html).toContain(
      '<p><a href="https://bsky.app/profile/did:plc:hheutzl4mxedshsz4yqek5tt/post/3mk3up2q3ac2s"><strong>View post on Bluesky</strong></a></p>',
    );
    expect(awards.converted.html).toContain(
      `<a href="https://newpublic.org/OSA"><img src="${buildBlueskyCdnImageUrl(awards.did, "bafkreihxltf7o24577u3ljbkrp73a7wfkhsds5ksidxqd2rnda2mw36vgi")}" alt="Open Social Awards | New_ Public"></a><p><a href="https://newpublic.org/OSA"><strong>Open Social Awards | New_ Public</strong></a><br>The awards aim`,
    );
    expect(awards.converted.html).toContain(
      '<p><a href="https://app.formbricks.com/s/cmn3lqvw6b5lfv101shpmepis"><strong>Apply for Open Social Awards</strong></a></p>',
    );
    expect(awards.converted.html).toContain("<hr>");
  });

  it("renders an offprint image grid as one figure holding every image", async () => {
    const { converted, did: fixtureDid } = await convertFixture(
      "offprint-nyc-community-day",
    );
    const figures = converted.html.match(/<figure>.*?<\/figure>/g) ?? [];
    expect(figures).toHaveLength(1);
    expect(count(figures[0]!, /<img /g)).toBe(6);
    expect(figures[0]).toContain(
      `<img src="${buildBlueskyCdnImageUrl(fixtureDid, "bafkreig3qmi6eerg2qbs2xwyrpihzjbewafn4skfli456s26pdzgl6exrq")}" alt="">`,
    );
  });

  it("renders pckt text, blob images, and blockquotes", async () => {
    const { converted, did: fixtureDid } = await convertFixture(
      "pckt-science-vs-vegetable-faces",
    );
    expect(converted.html).toContain(
      '<a href="https://plus.maths.org/earth-moves">',
    );
    expect(converted.html).toContain("<blockquote><p><em>");
    expect(converted.html).toContain(
      `<figure><img src="${buildBlueskyCdnImageUrl(fixtureDid, "bafkreidfex4cfyjmuk26c3zzw7hshzj5er4aisvzhn2qqdtrh6pu2kltuq")}" alt="arcimboldo`,
    );
    expect(converted.firstImageUrl).toBe(
      buildBlueskyCdnImageUrl(
        fixtureDid,
        "bafkreidfex4cfyjmuk26c3zzw7hshzj5er4aisvzhn2qqdtrh6pu2kltuq",
      ),
    );
  });

  it("renders a pckt YouTube iframe and a bullet list", async () => {
    const { converted } = await convertFixture("pckt-cant-stop-crediting");
    expect(converted.html).toContain(
      '<div data-serial-embed="youtube" data-video-id="8DyziWtkfBw">',
    );
    expect(count(converted.html, /<li>/g)).toBe(24);
  });
});

describe("convertDocumentContent content resolution", () => {
  it("returns null for documents without block-native content", async () => {
    await expect(
      convertDocumentContent(
        { content: undefined },
        { did, loadBlob: rejectingBlobLoader },
      ),
    ).resolves.toBeNull();
    await expect(
      convertDocumentContent(
        { content: { $type: "com.example.content", body: "<p>x</p>" } },
        { did, loadBlob: rejectingBlobLoader },
      ),
    ).resolves.toBeNull();
  });

  it("skips canvas pages and returns null when nothing renders", async () => {
    const canvasOnly = {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.canvas",
          blocks: [
            {
              block: {
                $type: "pub.leaflet.blocks.text",
                plaintext: "positioned",
              },
              x: 0,
              y: 0,
              width: 10,
            },
          ],
        },
      ],
    };
    await expect(
      convertDocumentContent(
        { content: canvasOnly },
        { did, loadBlob: rejectingBlobLoader },
      ),
    ).resolves.toBeNull();
    const mixed = {
      ...canvasOnly,
      pages: [
        ...canvasOnly.pages,
        ...leaflet([{ $type: "pub.leaflet.blocks.text", plaintext: "linear" }])
          .pages,
      ],
    };
    await expect(
      convertDocumentContent(
        { content: mixed },
        { did, loadBlob: rejectingBlobLoader },
      ),
    ).resolves.toMatchObject({ html: "<p>linear</p>" });
  });

  it("reads leaflet pages from blobPages and ignores inline pages", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          ...leaflet([
            { $type: "pub.leaflet.blocks.text", plaintext: "inline stub" },
          ]),
          blobPages: {
            $type: "blob",
            ref: { $link: "bafypages" },
            mimeType: "application/json",
            size: 1,
          },
        },
      },
      {
        did,
        loadBlob: stubBlobLoader({
          bafypages: leaflet([
            { $type: "pub.leaflet.blocks.text", plaintext: "from blob" },
          ]).pages,
        }),
      },
    );
    expect(converted?.html).toBe("<p>from blob</p>");
  });

  it("reads pckt items from the overflow blob when items are absent or empty", async () => {
    const blob = {
      $type: "blob",
      ref: { $link: "bafyitems" },
      mimeType: "application/json",
      size: 1,
    };
    const loadBlob = stubBlobLoader({
      bafyitems: {
        items: [{ $type: "blog.pckt.block.text", plaintext: "extended" }],
      },
    });
    await expect(
      convertDocumentContent(
        { content: { $type: "blog.pckt.content", blob } },
        { did, loadBlob },
      ),
    ).resolves.toMatchObject({ html: "<p>extended</p>" });
    await expect(
      convertDocumentContent(
        { content: { $type: "blog.pckt.content", items: [], blob } },
        { did, loadBlob },
      ),
    ).resolves.toMatchObject({ html: "<p>extended</p>" });
  });

  it("prefers inline pckt items over the blob when both are present", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          ...pckt([{ $type: "blog.pckt.block.text", plaintext: "inline" }]),
          blob: {
            $type: "blob",
            ref: { $link: "bafyitems" },
            mimeType: "application/json",
            size: 1,
          },
        },
      },
      { did, loadBlob: rejectingBlobLoader },
    );
    expect(converted?.html).toBe("<p>inline</p>");
  });
});

describe("youtube references", () => {
  it("reads start offsets from share and embed links", () => {
    expect(parseYouTubeReference("https://youtu.be/abcdefghijk?t=30s")).toEqual(
      {
        videoId: "abcdefghijk",
        start: "30",
      },
    );
    expect(
      parseYouTubeReference(
        "https://www.youtube.com/embed/abcdefghijk?start=5",
      ),
    ).toEqual({ videoId: "abcdefghijk", start: "5" });
    expect(
      parseYouTubeReference("https://www.youtube.com/watch?v=abcdefghijk&t=1m"),
    ).toEqual({ videoId: "abcdefghijk", start: null });
  });
});

describe("leaflet blocks", () => {
  it("drops only the bad entries of a gallery and empty list items", () => {
    const html = convertRaw(
      leaflet([
        {
          $type: "pub.leaflet.blocks.imageGallery",
          images: [
            "junk",
            {
              image: { ref: { $link: "bafyok" }, mimeType: "image/png" },
              alt: "ok",
            },
            { image: { ref: { $link: "bafybad" } } },
          ],
        },
        {
          $type: "pub.leaflet.blocks.unorderedList",
          children: [
            { content: { $type: "pub.leaflet.blocks.horizontalRule" } },
            {
              content: { $type: "pub.leaflet.blocks.text", plaintext: "kept" },
            },
          ],
        },
      ]),
    );
    expect(html).toBe(
      `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafyok")}" alt="ok"></figure>` +
        "<ul><li>kept</li></ul>",
    );
    expectFixedPoint(html);
  });

  it("sanitizes html blocks and falls back to the interactive placeholder", () => {
    const html = convertRaw(
      leaflet([
        {
          $type: "pub.leaflet.blocks.html",
          html: '<p onclick="x()" id="x">kept</p><script>bad()</script>',
        },
        { $type: "pub.leaflet.blocks.html", html: "<script>only()</script>" },
        {
          $type: "pub.leaflet.blocks.iframe",
          url: "https://tally.so/embed/abc",
        },
        { $type: "pub.leaflet.blocks.iframe", height: 400 },
        {
          $type: "pub.leaflet.blocks.iframe",
          url: "https://x.test",
          html: "<em>srcdoc wins</em>",
        },
      ]),
    );
    const bare = `<div data-serial-embed="interactive"><p>${INTERACTIVE_PLACEHOLDER_TEXT}</p></div>`;
    expect(html).toBe(
      "<p>kept</p>" +
        bare +
        `<div data-serial-embed="interactive" data-href="https://tally.so/embed/abc"><p><a href="https://tally.so/embed/abc">${INTERACTIVE_PLACEHOLDER_TEXT}</a></p></div>` +
        bare +
        "<em>srcdoc wins</em>",
    );
    expectFixedPoint(html);
  });

  it("renders checklists, nested lists of both kinds, code, math, and footnotes", () => {
    const html = convertRaw(
      leaflet([
        {
          $type: "pub.leaflet.blocks.orderedList",
          startIndex: 3,
          children: [
            {
              content: { $type: "pub.leaflet.blocks.text", plaintext: "first" },
              children: [
                {
                  content: {
                    $type: "pub.leaflet.blocks.text",
                    plaintext: "same kind",
                  },
                },
              ],
            },
            {
              content: {
                $type: "pub.leaflet.blocks.header",
                plaintext: "second",
              },
              unorderedListChildren: {
                children: [
                  {
                    content: {
                      $type: "pub.leaflet.blocks.text",
                      plaintext: "done",
                    },
                    checked: true,
                  },
                ],
              },
            },
          ],
        },
        {
          $type: "pub.leaflet.blocks.code",
          plaintext: "a < b && c",
          language: "ts",
        },
        { $type: "pub.leaflet.blocks.math", tex: "x^2" },
        {
          $type: "pub.leaflet.blocks.text",
          plaintext: "Cited claim",
          facets: [
            {
              index: { byteStart: 0, byteEnd: 11 },
              features: [
                {
                  $type: "pub.leaflet.richtext.facet#footnote",
                  footnoteId: "n1",
                  contentPlaintext: "The source",
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(html).toBe(
      '<ol start="3"><li>first<ol><li>same kind</li></ol></li><li><strong>second</strong><ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> done</li></ul></li></ol>' +
        '<pre><code class="language-ts">a &#x3C; b &#x26;&#x26; c</code></pre>' +
        '<pre><code class="language-tex">x^2</code></pre>' +
        "<p>Cited claim<sup>[1]</sup></p>" +
        "<section><ol><li>The source</li></ol></section>",
    );
    expectFixedPoint(html);
  });

  it("renders standard.site embeds as link cards and drops publication-only blocks", () => {
    const html = convertRaw(
      leaflet([
        {
          $type: "pub.leaflet.blocks.standardSitePost",
          uri: "at://did:plc:a/site.standard.document/b",
        },
        {
          $type: "pub.leaflet.blocks.standardSitePublication",
          uri: "at://did:plc:a/site.standard.publication/c",
        },
        { $type: "pub.leaflet.blocks.page", id: "sub" },
        {
          $type: "pub.leaflet.blocks.poll",
          pollRef: { uri: "at://x/y/z", cid: "c" },
        },
        { $type: "pub.leaflet.blocks.postsList" },
        { $type: "pub.leaflet.blocks.signup" },
        { $type: "pub.leaflet.blocks.membersOnlyDelimiter", audience: "paid" },
        {
          $type: "pub.leaflet.blocks.imageGallery",
          images: [
            {
              image: { ref: { $link: "bafyimg" }, mimeType: "image/png" },
              alt: "g",
            },
          ],
        },
        { $type: "pub.leaflet.blocks.standardSitePost", uri: "../../evil" },
        { $type: "pub.leaflet.blocks.header", plaintext: "   " },
        { $type: "pub.leaflet.blocks.blockquote", plaintext: " " },
        { $type: "pub.leaflet.blocks.unorderedList", children: [] },
        {
          $type: "pub.leaflet.blocks.header#main",
          plaintext: "Suffixed",
          level: 3,
        },
      ]),
    );
    expect(html).toContain('data-serial-embed="record"');
    expect(html).toContain('data-size="row"');
    expect(html).toContain('href="https://pdsls.dev/at://did:plc:a/site.standard.document/b"');
    expect(html).toContain('href="https://pdsls.dev/at://did:plc:a/site.standard.publication/c"');
    expect(html).toContain(`<figure><img src="${buildBlueskyCdnImageUrl(did, "bafyimg")}" alt="g"></figure><h3>Suffixed</h3>`);
    expect(html).not.toContain("../../evil");
    expectFixedPoint(html);
  });

  it("renders buttons, math, youtube offsets, and code without a usable language", () => {
    const html = convertRaw(
      leaflet([
        {
          $type: "pub.leaflet.blocks.button",
          text: "Sign up",
          url: "https://a.test/go",
        },
        { $type: "pub.leaflet.blocks.math", tex: "a < b" },
        { $type: "pub.leaflet.blocks.code", plaintext: "x", language: "!!!" },
        {
          $type: "pub.leaflet.blocks.iframe",
          url: "https://youtu.be/abcdefghijk?t=30s",
        },
        {
          $type: "pub.leaflet.blocks.orderedList",
          startIndex: 1.5,
          children: [
            { content: { $type: "pub.leaflet.blocks.text", plaintext: "one" } },
          ],
        },
      ]),
    );
    expect(html).toBe(
      '<p><a href="https://a.test/go"><strong>Sign up</strong></a></p>' +
        '<pre><code class="language-tex">a &#x3C; b</code></pre>' +
        "<pre><code>x</code></pre>" +
        '<div data-serial-embed="youtube" data-video-id="abcdefghijk" data-start="30"><p><a href="https://www.youtube.com/watch?v=abcdefghijk">Watch on YouTube</a></p></div>' +
        "<ol><li>one</li></ol>",
    );
    expectFixedPoint(html);
  });

  it("drops a malformed page but keeps the rest of the document", () => {
    const content = {
      $type: "pub.leaflet.content",
      pages: [
        "junk",
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: [
            { block: { $type: "pub.leaflet.blocks.text", plaintext: "kept" } },
          ],
        },
        { $type: "pub.leaflet.pages.linearDocument", blocks: "not an array" },
      ],
    };
    expect(convertResolvedContent(content, did)?.html).toBe("<p>kept</p>");
  });

  it("renders a multi-image leaflet gallery as one figure per image", () => {
    const html = convertRaw(
      leaflet([
        {
          $type: "pub.leaflet.blocks.imageGallery",
          images: [
            {
              image: { ref: { $link: "bafyone" }, mimeType: "image/png" },
              alt: "1",
            },
            {
              image: { ref: { $link: "bafytwo" }, mimeType: "image/png" },
              alt: "2",
            },
          ],
        },
      ]),
    );
    expect(html).toBe(
      `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafyone")}" alt="1"></figure>` +
        `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafytwo")}" alt="2"></figure>`,
    );
  });

  it("keeps quoted text out of the description fallback and drops unsafe blob cids", () => {
    const converted = convertResolvedContent(
      leaflet([
        { $type: "pub.leaflet.blocks.blockquote", plaintext: "quoted" },
        {
          $type: "pub.leaflet.blocks.image",
          image: { ref: { $link: "../../evil" }, mimeType: "image/png" },
          aspectRatio: { width: 1, height: 1 },
        },
        { $type: "pub.leaflet.blocks.text", plaintext: "body" },
      ]),
      did,
    );
    expect(converted?.html).toBe(
      "<blockquote><p>quoted</p></blockquote><p>body</p>",
    );
    expect(converted?.firstParagraph).toBe("body");
    expect(converted?.firstImageUrl).toBeNull();
  });

  it("stops rendering past the nesting depth limit", () => {
    let item: Record<string, unknown> = {
      content: { $type: "pub.leaflet.blocks.text", plaintext: "leaf" },
    };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH * 4; depth += 1) {
      item = {
        content: { $type: "pub.leaflet.blocks.text", plaintext: "level" },
        children: [item],
      };
    }
    const html = convertRaw(
      leaflet([
        { $type: "pub.leaflet.blocks.unorderedList", children: [item] },
      ]),
    );
    expect(count(html, /<ul>/g)).toBe(MAX_BLOCK_NESTING_DEPTH);
    expect(html).not.toContain("leaf");
    expectFixedPoint(html);
  });
});

describe("pckt blocks", () => {
  it("renders tables, task lists, hard breaks, mentions, and external images", () => {
    const html = convertRaw(
      pckt([
        {
          $type: "blog.pckt.block.table",
          content: [
            {
              $type: "blog.pckt.block.tableRow",
              content: [
                {
                  $type: "blog.pckt.block.tableHeader",
                  colspan: 2,
                  content: [
                    { $type: "blog.pckt.block.text", plaintext: "Head" },
                  ],
                },
              ],
            },
            {
              $type: "blog.pckt.block.tableRow",
              content: [
                {
                  $type: "blog.pckt.block.tableCell",
                  content: [{ $type: "blog.pckt.block.text", plaintext: "a" }],
                },
                {
                  $type: "blog.pckt.block.tableCell",
                  rowspan: 2,
                  content: [
                    { $type: "blog.pckt.block.codeBlock", plaintext: "code()" },
                  ],
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
              checked: false,
              content: [{ $type: "blog.pckt.block.text", plaintext: "todo" }],
            },
          ],
        },
        { $type: "blog.pckt.block.hardBreak" },
        {
          $type: "blog.pckt.block.mention",
          did: "did:plc:abc",
          handle: "alice.test",
        },
        {
          $type: "blog.pckt.block.mention",
          did: 'did:plc:x" onclick="x()',
          handle: "evil",
        },
        {
          $type: "blog.pckt.block.image",
          attrs: {
            src: "https://example.com/a.png",
            alt: "it's",
            title: "Cap",
          },
        },
        {
          $type: "blog.pckt.block.image",
          attrs: { src: "javascript:alert(1)" },
        },
        {
          $type: "blog.pckt.block.website",
          src: "https://example.com",
          title: "Example",
          previewImage: "https://example.com/p.png",
        },
        { $type: "blog.pckt.block.iframe" },
        {
          $type: "blog.pckt.block.gallery",
          ref: "at://did:plc:a/blog.pckt.gallery/b",
        },
        {
          $type: "blog.pckt.block.noteEmbed",
          noteRef: { uri: "at://x/y/z", cid: "c" },
        },
        {
          $type: "blog.pckt.block.blueskyEmbed",
          postRef: { uri: "at://did:plc:p/app.bsky.feed.post/3k", cid: "c" },
        },
        { $type: "blog.pckt.block.bulletList", content: [] },
      ]),
    );
    expect(html).toBe(
      '<table><tbody><tr><th colspan="2">Head</th></tr><tr><td>a</td><td rowspan="2"><pre><code>code()</code></pre></td></tr></tbody></table>' +
        '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>' +
        "<br>" +
        '<p><a href="https://bsky.app/profile/did:plc:abc">@alice.test</a></p>' +
        `<figure><img src="https://example.com/a.png" alt="it&#x27;s" title="Cap"></figure>` +
        '<a href="https://example.com/"><img src="https://example.com/p.png" alt="Example"></a><p><a href="https://example.com/"><strong>Example</strong></a></p>' +
        `<div data-serial-embed="interactive"><p>${INTERACTIVE_PLACEHOLDER_TEXT}</p></div>` +
        '<p><a href="https://bsky.app/profile/did:plc:p/post/3k"><strong>View post on Bluesky</strong></a></p>',
    );
    expectFixedPoint(html);
  });

  it("treats a def-suffixed table header cell as a header", () => {
    const html = convertRaw(
      pckt([
        {
          $type: "blog.pckt.block.table",
          content: [
            {
              $type: "blog.pckt.block.tableRow#main",
              content: [
                {
                  $type: "blog.pckt.block.tableHeader#main",
                  content: [{ $type: "blog.pckt.block.text", plaintext: "H" }],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(html).toBe("<table><tbody><tr><th>H</th></tr></tbody></table>");
  });

  it("caps nesting depth without breaking the rest of the document", () => {
    const after = { $type: "blog.pckt.block.text", plaintext: "after" };
    let quote: Record<string, unknown> = {
      $type: "blog.pckt.block.text",
      plaintext: "leaf",
    };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH * 4; depth += 1) {
      quote = { $type: "blog.pckt.block.blockquote", content: [quote] };
    }
    // Every quote past the cap renders nothing, so the whole chain collapses.
    expect(convertRaw(pckt([quote, after]))).toBe("<p>after</p>");

    let item: Record<string, unknown> = {
      $type: "blog.pckt.block.text",
      plaintext: "leaf",
    };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH * 4; depth += 1) {
      item = {
        $type: "blog.pckt.block.bulletList",
        content: [{ $type: "blog.pckt.block.listItem", content: [item] }],
      };
    }
    expect(convertRaw(pckt([item, after]))).toBe("<p>after</p>");

    let table: Record<string, unknown> = {
      $type: "blog.pckt.block.text",
      plaintext: "leaf",
    };
    for (let depth = 0; depth < MAX_BLOCK_NESTING_DEPTH * 4; depth += 1) {
      table = {
        $type: "blog.pckt.block.table",
        content: [
          {
            $type: "blog.pckt.block.tableRow",
            content: [{ $type: "blog.pckt.block.tableCell", content: [table] }],
          },
        ],
      };
    }
    expect(convertRaw(pckt([table, after]))).toBe("<p>after</p>");
  });

  it("drops task items and list items with nothing to show", () => {
    const html = convertRaw(
      pckt([
        {
          $type: "blog.pckt.block.taskList",
          content: [
            { $type: "blog.pckt.block.taskItem", checked: true, content: [] },
            {
              $type: "blog.pckt.block.taskItem",
              checked: false,
              content: [{ $type: "blog.pckt.block.text", plaintext: "real" }],
            },
          ],
        },
        {
          $type: "blog.pckt.block.orderedList",
          start: 4,
          content: [
            {
              $type: "blog.pckt.block.listItem",
              content: [{ $type: "blog.pckt.block.text", plaintext: "four" }],
            },
          ],
        },
      ]),
    );
    expect(html).toBe(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> real</li></ul>' +
        '<ol start="4"><li>four</li></ol>',
    );
  });
});

describe("offprint blocks", () => {
  it("renders task lists, blockquote headings, captions, carousels, and unknown blocks", () => {
    const html = convertRaw(
      offprint([
        {
          $type: "app.offprint.block.taskList",
          children: [
            {
              checked: true,
              content: {
                $type: "app.offprint.block.text",
                plaintext: "shipped",
              },
            },
            {
              checked: false,
              content: { $type: "app.offprint.block.text", plaintext: "next" },
            },
          ],
        },
        {
          $type: "app.offprint.block.blockquote",
          content: [
            {
              $type: "app.offprint.block.heading",
              level: 3,
              plaintext: "Quote title",
            },
            { $type: "app.offprint.block.text", plaintext: "Quote body" },
          ],
        },
        {
          $type: "app.offprint.block.codeBlock",
          code: "print(1)",
          language: "python",
        },
        {
          $type: "app.offprint.block.webEmbed",
          href: "https://vimeo.com/1",
          embedUrl: "https://player.vimeo.com/video/1",
        },
        {
          $type: "app.offprint.block.image",
          image: { ref: { $link: "bafyone" }, mimeType: "image/png" },
          alt: "one",
          caption: "Bold cap",
          captionFacets: [
            {
              index: { byteStart: 0, byteEnd: 4 },
              features: [{ $type: "app.offprint.richtext.facet#bold" }],
            },
          ],
        },
        {
          $type: "app.offprint.block.imageCarousel",
          caption: "Two & three",
          images: [
            {
              blob: { ref: { $link: "bafytwo" }, mimeType: "image/png" },
              alt: "two",
            },
            { image: { ref: { $link: "bafythree" }, mimeType: "image/png" } },
          ],
        },
        {
          $type: "app.offprint.block.imageDiff",
          images: [
            {
              blob: { ref: { $link: "bafybefore" }, mimeType: "image/png" },
              alt: "before",
            },
            {
              blob: { ref: { $link: "bafyafter" }, mimeType: "image/png" },
              alt: "after",
            },
          ],
        },
        {
          $type: "app.offprint.block.component",
          component: "at://did:plc:x/app.offprint.component/y",
        },
        {
          $type: "app.offprint.block.future",
          plaintext: "unknown but textual",
        },
      ]),
    );
    expect(html).toBe(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> shipped</li><li class="task-list-item"><input type="checkbox" disabled> next</li></ul>' +
        "<blockquote><h3>Quote title</h3><p>Quote body</p></blockquote>" +
        '<pre><code class="language-python">print(1)</code></pre>' +
        `<div data-serial-embed="interactive" data-href="https://vimeo.com/1"><p><a href="https://vimeo.com/1">${INTERACTIVE_PLACEHOLDER_TEXT}</a></p></div>` +
        `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafyone")}" alt="one"><figcaption><strong>Bold</strong> cap</figcaption></figure>` +
        `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafytwo")}" alt="two"><img src="${buildBlueskyCdnImageUrl(did, "bafythree")}" alt=""><figcaption>Two &#x26; three</figcaption></figure>` +
        `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafybefore")}" alt="before"><img src="${buildBlueskyCdnImageUrl(did, "bafyafter")}" alt="after"></figure>` +
        "<p>unknown but textual</p>",
    );
    expectFixedPoint(html);
  });

  it.each(["imageGrid", "imageCarousel", "imageDiff"])(
    "keeps valid %s images beside malformed entries",
    (kind) => {
      const html = convertRaw(
        offprint([
          {
            $type: `app.offprint.block.${kind}`,
            images: [
              {
                blob: { ref: { $link: "bafyone" }, mimeType: "image/png" },
                alt: "first",
              },
              null,
              { blob: "invalid" },
              {
                image: { ref: { $link: "bafytwo" }, mimeType: "image/png" },
                alt: "second",
              },
            ],
            caption: "Both images",
          },
        ]),
      );
      expect(html).toBe(
        `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafyone")}" alt="first"><img src="${buildBlueskyCdnImageUrl(did, "bafytwo")}" alt="second"><figcaption>Both images</figcaption></figure>`,
      );
      expectFixedPoint(html);
    },
  );

  it("keeps an image whose caption facets are malformed and drops empty list items", () => {
    const html = convertRaw(
      offprint([
        {
          $type: "app.offprint.block.image",
          image: { ref: { $link: "bafyimg" }, mimeType: "image/png" },
          caption: "Cap",
          captionFacets: ["garbage"],
        },
        {
          $type: "app.offprint.block.bulletList",
          children: [
            {},
            {
              content: { $type: "app.offprint.block.text", plaintext: "kept" },
            },
          ],
        },
        {
          $type: "app.offprint.block.orderedList",
          start: 7,
          children: [
            {
              content: { $type: "app.offprint.block.text", plaintext: "seven" },
            },
          ],
        },
        { $type: "app.offprint.block.mathBlock", tex: "e=mc^2" },
      ]),
    );
    expect(html).toBe(
      `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafyimg")}" alt=""><figcaption>Cap</figcaption></figure>` +
        "<ul><li>kept</li></ul>" +
        '<ol start="7"><li>seven</li></ol>' +
        '<pre><code class="language-tex">e=mc^2</code></pre>',
    );
    expectFixedPoint(html);
  });

  it("keeps callouts and blockquotes out of the description fallback", () => {
    const converted = convertResolvedContent(
      offprint([
        { $type: "app.offprint.block.callout", plaintext: "aside" },
        {
          $type: "app.offprint.block.blockquote",
          content: [{ $type: "app.offprint.block.text", plaintext: "quoted" }],
        },
        { $type: "app.offprint.block.text", plaintext: "body" },
      ]),
      did,
    );
    expect(converted?.firstParagraph).toBe("body");
  });
});

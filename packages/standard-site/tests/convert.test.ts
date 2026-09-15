import { describe, expect, it } from "vitest";
import {
  convertDocumentContent,
  INTERACTIVE_PLACEHOLDER_TEXT,
} from "../src/convert";
import { sanitizeArticleHtml } from "../src/sanitize";
import { buildBlueskyCdnImageUrl } from "../src/uris";
import {
  FIXTURE_DOCUMENTS,
  loadDocumentFixture,
  rejectingBlobLoader,
  stubBlobLoader,
} from "./fixtures";
import type { FixtureName } from "./fixtures";

async function convertFixture(name: FixtureName) {
  const { record, did } = loadDocumentFixture(name);
  const converted = await convertDocumentContent(record.value, {
    did,
    loadBlob: rejectingBlobLoader,
  });
  if (!converted) throw new Error(`Fixture ${name} did not convert`);
  return { converted, did, record };
}

function count(html: string, pattern: RegExp) {
  return html.match(pattern)?.length ?? 0;
}

describe("convertDocumentContent fixtures", () => {
  it.each(FIXTURE_DOCUMENTS)("%s is a sanitizer fixed point", async (name) => {
    const { converted } = await convertFixture(name);
    expect(sanitizeArticleHtml(converted.html)).toBe(converted.html);
    expect(converted.html).not.toMatch(/<(iframe|script|style)\b/);
  });

  it.each(FIXTURE_DOCUMENTS)("%s matches its snapshot", async (name) => {
    const { converted } = await convertFixture(name);
    await expect(converted.html).toMatchFileSnapshot(
      `./__snapshots__/${name}.html`,
    );
  });

  it("renders leaflet text, headers, images, lists, link cards, and posts", async () => {
    const { converted, did } = await convertFixture("leaflet-montreal-recap");
    expect(
      converted.html.startsWith(
        "<p>The ATProto community gathered in Montreal",
      ),
    ).toBe(true);
    expect(count(converted.html, /<h1>/g)).toBe(5);
    expect(count(converted.html, /<h2>/g)).toBe(6);
    expect(converted.html).toContain(
      `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafkreie4phcb3tltjqhb2qws3rq72ipztoweb5ynjkdklr72iptdj5ine4")}" alt="Group of people`,
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
        did,
        "bafkreie4phcb3tltjqhb2qws3rq72ipztoweb5ynjkdklr72iptdj5ine4",
      ),
    );
  });

  it("renders a leaflet YouTube iframe as the youtube placeholder", async () => {
    const { converted, did } = await convertFixture("leaflet-network-punk");
    expect(
      converted.html.startsWith(
        '<div data-serial-embed="youtube" data-video-id="d-H1nzWHLoI"><p><a href="https://www.youtube.com/watch?v=d-H1nzWHLoI">Watch on YouTube</a></p></div>',
      ),
    ).toBe(true);
    expect(converted.html).toContain("<blockquote><p>");
    expect(converted.html).toContain("<hr>");
    expect(converted.firstImageUrl).toBe(
      buildBlueskyCdnImageUrl(
        did,
        "bafkreiefsccyzsc724jax75xxjhu7u2fic6b7pdzuoen33smejmrovsyiu",
      ),
    );
  });

  it("renders offprint callouts, mentions, highlights, lists, and images", async () => {
    const { converted, did } = await convertFixture(
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
      `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafkreifqczfh25syz3yywxr5tbcp4amtwmnqr4lnplmcshkp7w2mdu25wq")}" alt=""></figure>`,
    );
    expect(converted.html.endsWith("</p>")).toBe(true);
    expect(converted.html).not.toContain("<p></p>");
  });

  it("renders offprint web embeds, bookmarks, posts, and buttons", async () => {
    const embed = await convertFixture("offprint-bluesky-and-did-plc");
    expect(embed.converted.html).toContain(
      '<div data-serial-embed="youtube" data-video-id="m9AVUAUDC2A"><p><a href="https://www.youtube.com/watch?v=m9AVUAUDC2A">Watch on YouTube</a></p></div>',
    );
    expect(embed.converted.html).toContain(
      "<blockquote><p>💡 Figure out how to upload",
    );

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

  it("renders an offprint image grid as a captionless figure of images", async () => {
    const { converted } = await convertFixture("offprint-nyc-community-day");
    expect(count(converted.html, /<figure><img /g)).toBe(1);
    expect(count(converted.html, /<img /g)).toBeGreaterThanOrEqual(4);
  });

  it("renders pckt text, blob images, blockquotes, and lists", async () => {
    const { converted, did } = await convertFixture(
      "pckt-science-vs-vegetable-faces",
    );
    expect(converted.html).toContain(
      '<a href="https://plus.maths.org/earth-moves">',
    );
    expect(converted.html).toContain("<blockquote><p><em>");
    expect(converted.html).toContain(
      `<figure><img src="${buildBlueskyCdnImageUrl(did, "bafkreidfex4cfyjmuk26c3zzw7hshzj5er4aisvzhn2qqdtrh6pu2kltuq")}" alt="arcimboldo`,
    );
    expect(converted.firstImageUrl).toBe(
      buildBlueskyCdnImageUrl(
        did,
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

describe("convertDocumentContent edge cases", () => {
  const did = "did:plc:example";

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

  it("returns null when the converted body is empty", async () => {
    await expect(
      convertDocumentContent(
        {
          content: {
            $type: "pub.leaflet.content",
            pages: [{ $type: "pub.leaflet.pages.canvas", blocks: [] }],
          },
        },
        { did, loadBlob: rejectingBlobLoader },
      ),
    ).resolves.toBeNull();
  });

  it("reads leaflet pages from blobPages and ignores inline pages", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          $type: "pub.leaflet.content",
          pages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: {
                    $type: "pub.leaflet.blocks.text",
                    plaintext: "inline stub",
                  },
                },
              ],
            },
          ],
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
          bafypages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: {
                    $type: "pub.leaflet.blocks.text",
                    plaintext: "from blob",
                  },
                },
              ],
            },
          ],
        }),
      },
    );
    expect(converted?.html).toBe("<p>from blob</p>");
  });

  it("reads pckt items from the overflow blob when items are absent", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          $type: "blog.pckt.content",
          blob: {
            $type: "blob",
            ref: { $link: "bafyitems" },
            mimeType: "application/json",
            size: 1,
          },
        },
      },
      {
        did,
        loadBlob: stubBlobLoader({
          bafyitems: {
            items: [{ $type: "blog.pckt.block.text", plaintext: "extended" }],
          },
        }),
      },
    );
    expect(converted?.html).toBe("<p>extended</p>");
  });

  it("sanitizes leaflet html blocks and falls back to the interactive placeholder", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          $type: "pub.leaflet.content",
          pages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: {
                    $type: "pub.leaflet.blocks.html",
                    html: '<p onclick="x()">kept</p><script>bad()</script>',
                  },
                },
                {
                  block: {
                    $type: "pub.leaflet.blocks.html",
                    html: "<script>only()</script>",
                  },
                },
                {
                  block: {
                    $type: "pub.leaflet.blocks.iframe",
                    url: "https://tally.so/embed/abc",
                  },
                },
              ],
            },
          ],
        },
      },
      { did, loadBlob: rejectingBlobLoader },
    );
    expect(converted?.html).toBe(
      "<p>kept</p>" +
        `<div data-serial-embed="interactive"><p>${INTERACTIVE_PLACEHOLDER_TEXT}</p></div>` +
        `<div data-serial-embed="interactive" data-href="https://tally.so/embed/abc"><p><a href="https://tally.so/embed/abc">${INTERACTIVE_PLACEHOLDER_TEXT}</a></p></div>`,
    );
    expect(sanitizeArticleHtml(converted!.html)).toBe(converted!.html);
  });

  it("renders leaflet checklists, nested lists, code, math, and footnotes", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          $type: "pub.leaflet.content",
          pages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: {
                    $type: "pub.leaflet.blocks.orderedList",
                    startIndex: 3,
                    children: [
                      {
                        content: {
                          $type: "pub.leaflet.blocks.text",
                          plaintext: "first",
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
                },
                {
                  block: {
                    $type: "pub.leaflet.blocks.code",
                    plaintext: "a < b && c",
                    language: "ts",
                  },
                },
                { block: { $type: "pub.leaflet.blocks.math", tex: "x^2" } },
                {
                  block: {
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
                },
              ],
            },
          ],
        },
      },
      { did, loadBlob: rejectingBlobLoader },
    );
    expect(converted?.html).toBe(
      '<ol start="3"><li>first<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> done</li></ul></li></ol>' +
        '<pre><code class="language-ts">a &#x3C; b &#x26;&#x26; c</code></pre>' +
        '<pre><code class="language-tex">x^2</code></pre>' +
        "<p>Cited claim<sup>[1]</sup></p>" +
        "<section><ol><li>The source</li></ol></section>",
    );
    expect(sanitizeArticleHtml(converted!.html)).toBe(converted!.html);
  });

  it("renders pckt tables, task lists, hard breaks, mentions, and external images", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          $type: "blog.pckt.content",
          items: [
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
                      content: [
                        { $type: "blog.pckt.block.text", plaintext: "a" },
                      ],
                    },
                    {
                      $type: "blog.pckt.block.tableCell",
                      rowspan: 2,
                      content: [
                        { $type: "blog.pckt.block.text", plaintext: "b" },
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
                  content: [
                    { $type: "blog.pckt.block.text", plaintext: "todo" },
                  ],
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
              $type: "blog.pckt.block.image",
              attrs: {
                src: "https://example.com/a.png",
                alt: "ext",
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
          ],
        },
      },
      { did, loadBlob: rejectingBlobLoader },
    );
    expect(converted?.html).toBe(
      '<table><tbody><tr><th colspan="2">Head</th></tr><tr><td>a</td><td rowspan="2">b</td></tr></tbody></table>' +
        '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>' +
        "<br>" +
        '<p><a href="https://bsky.app/profile/did:plc:abc">@alice.test</a></p>' +
        '<figure><img src="https://example.com/a.png" alt="ext"><figcaption>Cap</figcaption></figure>' +
        '<a href="https://example.com/"><img src="https://example.com/p.png" alt="Example"></a><p><a href="https://example.com/"><strong>Example</strong></a></p>',
    );
    expect(sanitizeArticleHtml(converted!.html)).toBe(converted!.html);
    expect(converted?.firstImageUrl).toBe("https://example.com/a.png");
  });

  it("renders offprint task lists and blockquote headings", async () => {
    const converted = await convertDocumentContent(
      {
        content: {
          $type: "app.offprint.content",
          items: [
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
                  content: {
                    $type: "app.offprint.block.text",
                    plaintext: "next",
                  },
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
              $type: "app.offprint.block.component",
              component: "at://did:plc:x/app.offprint.component/y",
            },
            {
              $type: "app.offprint.block.future",
              plaintext: "unknown but textual",
            },
          ],
        },
      },
      { did, loadBlob: rejectingBlobLoader },
    );
    expect(converted?.html).toBe(
      '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> shipped</li><li class="task-list-item"><input type="checkbox" disabled> next</li></ul>' +
        "<blockquote><h3>Quote title</h3><p>Quote body</p></blockquote>" +
        '<pre><code class="language-python">print(1)</code></pre>' +
        `<div data-serial-embed="interactive" data-href="https://vimeo.com/1"><p><a href="https://vimeo.com/1">${INTERACTIVE_PLACEHOLDER_TEXT}</a></p></div>` +
        "<p>unknown but textual</p>",
    );
    expect(sanitizeArticleHtml(converted!.html)).toBe(converted!.html);
  });
});

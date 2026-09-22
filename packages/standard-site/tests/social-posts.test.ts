import { describe, expect, it } from "vitest";
import {
  deriveResolvedContent,
  discoverReferences,
  handleFromDidDocument,
  nextReferenceHop,
  socialPostReferences,
} from "../src";
import type { ReaderBlock, RecordLookup } from "../src";
import { leaflet, offprint, pckt } from "./fixtures";

const author = "did:plc:author";
const quoter = "did:plc:quoter";
const post = `at://${author}/app.bsky.feed.post/post`;
const note = `at://${author}/blog.pckt.mini.post/note`;
const profile = `at://${author}/app.bsky.actor.profile/self`;
const blog = `at://${author}/site.standard.publication/blog`;
const quote = `at://${quoter}/app.bsky.feed.post/quoted`;
const document = `at://${quoter}/site.standard.document/article`;
const blob = (cid: string) => ({
  $type: "blob",
  ref: { $link: cid },
  mimeType: "image/jpeg",
});

function lookup(records: Record<string, unknown>): RecordLookup {
  return (uri) => {
    const value = records[uri];
    return value === undefined ? undefined : { uri, cid: "bafy", value };
  };
}

const resolved = {
  [post]: {
    $type: "app.bsky.feed.post",
    text: "hello @alice https://example.com",
    createdAt: "2026-07-15T22:08:33.054Z",
    facets: [
      {
        index: { byteStart: 6, byteEnd: 12 },
        features: [
          { $type: "app.bsky.richtext.facet#mention", did: "did:plc:alice" },
        ],
      },
      {
        index: { byteStart: 13, byteEnd: 32 },
        features: [
          { $type: "app.bsky.richtext.facet#link", uri: "https://example.com" },
        ],
      },
    ],
    embed: {
      $type: "app.bsky.embed.images",
      images: [
        { image: blob("bafyone"), alt: "One", aspectRatio: { width: 4, height: 3 } },
        { image: blob("bafytwo"), alt: "Two" },
      ],
    },
  },
  [profile]: {
    $type: "app.bsky.actor.profile",
    displayName: "Author",
    avatar: blob("bafyavatar"),
  },
  [author]: { id: author, alsoKnownAs: ["at://author.example"] },
};

function socialBlocks(content: unknown, records: RecordLookup) {
  return (
    deriveResolvedContent(content, author, records)?.blocks.flatMap((block) =>
      block.kind === "socialPost" ? [block] : [],
    ) ?? []
  );
}

describe("Bluesky post cards", () => {
  it.each([
    ["Leaflet", leaflet([{ $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } }])],
    ["pckt", pckt([{ $type: "blog.pckt.block.blueskyEmbed", postRef: { uri: post, cid: "bafy" } }])],
    ["Offprint", offprint([{ $type: "app.offprint.block.blueskyPost", post: { uri: post, cid: "bafy" } }])],
  ])("%s embeds resolve to one card with author, text, links and images", (_, content) => {
    const [block] = socialBlocks(content, lookup(resolved));
    expect(block?.post).toMatchObject({
      platform: "bluesky",
      url: `https://bsky.app/profile/${author}/post/post`,
      author: {
        did: author,
        handle: "author.example",
        name: "Author",
        avatarUrl: expect.stringContaining("/avatar/"),
        url: `https://bsky.app/profile/${author}`,
      },
      siteUrl: null,
      createdAt: "2026-07-15T22:08:33.054Z",
      mediaHidden: false,
      quote: null,
    });
    expect(block?.post.text).toEqual([
      { kind: "text", text: "hello ", marks: {}, link: null },
      {
        kind: "text",
        text: "@alice",
        marks: {},
        link: { href: "https://bsky.app/profile/did:plc:alice", record: null },
      },
      { kind: "text", text: " ", marks: {}, link: null },
      {
        kind: "text",
        text: "https://example.com",
        marks: {},
        link: { href: "https://example.com/", record: null },
      },
    ]);
    expect(block?.post.images).toEqual([
      expect.objectContaining({ alt: "One", aspectRatio: { width: 4, height: 3 } }),
      expect.objectContaining({ alt: "Two", aspectRatio: null }),
    ]);
    expect(block?.post.images[0]?.url).toContain(`/${author}/bafyone@jpeg`);
  });

  it("falls back to a row card to the post while the snapshot is absent", () => {
    const document = deriveResolvedContent(
      leaflet([{ $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } }]),
      author,
    );
    expect(document?.blocks[0]).toMatchObject({
      kind: "recordPreview",
      card: {
        uri: post,
        url: `https://bsky.app/profile/${author}/post/post`,
        title: "Post on Bluesky",
        size: "row",
      },
    });
    const card = (document?.blocks[0] as Extract<ReaderBlock, { kind: "recordPreview" }>).card;
    expect(JSON.stringify([card.title, card.description])).not.toContain("at://");
  });

  it("draws the card with whichever hops resolved", () => {
    const content = leaflet([
      { $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } },
    ]);
    const [withoutAuthor] = socialBlocks(content, lookup({ [post]: resolved[post] }));
    expect(withoutAuthor?.post.author).toEqual({
      did: author,
      handle: null,
      name: null,
      avatarUrl: null,
      url: `https://bsky.app/profile/${author}`,
    });
    const [withoutHandle] = socialBlocks(
      content,
      lookup({ [post]: resolved[post], [profile]: resolved[profile] }),
    );
    expect(withoutHandle?.post.author).toMatchObject({ handle: null, name: "Author" });
  });

  it("hides media behind adult and graphic self labels but keeps the text and links", () => {
    const [block] = socialBlocks(
      leaflet([{ $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } }]),
      lookup({
        ...resolved,
        [post]: {
          ...resolved[post],
          labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "porn" }] },
          embed: {
            $type: "app.bsky.embed.recordWithMedia",
            record: { $type: "app.bsky.embed.record", record: { uri: quote, cid: "bafy" } },
            media: {
              $type: "app.bsky.embed.external",
              external: { uri: "https://example.com/x", title: "X", description: "", thumb: blob("bafythumb") },
            },
          },
        },
      }),
    );
    expect(block?.post).toMatchObject({
      mediaHidden: true,
      images: [],
      video: null,
      external: { href: "https://example.com/x", title: "X", imageUrl: null },
    });
    expect(block?.post.text[0]).toMatchObject({ text: "hello " });
  });

  it("caps images at four and renders hashtags as plain text", () => {
    const [block] = socialBlocks(
      leaflet([{ $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } }]),
      lookup({
        ...resolved,
        [post]: {
          ...resolved[post],
          text: "tagged #atmosphere",
          facets: [
            {
              index: { byteStart: 7, byteEnd: 18 },
              features: [{ $type: "app.bsky.richtext.facet#tag", tag: "atmosphere" }],
            },
          ],
          embed: {
            $type: "app.bsky.embed.images",
            images: Array.from({ length: 6 }, (_, index) => ({
              image: blob(`bafy${index}`),
              alt: `Image ${index}`,
            })),
          },
        },
      }),
    );
    expect(block?.post.images.map((image) => image.alt)).toEqual([
      "Image 0",
      "Image 1",
      "Image 2",
      "Image 3",
    ]);
    expect(block?.post.text).toEqual([
      { kind: "text", text: "tagged #atmosphere", marks: {}, link: null },
    ]);
  });

  it("survives malformed embeds, labels and external previews", () => {
    const content = leaflet([
      { $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } },
    ]);
    for (const embed of ["x", 42, { $type: "app.bsky.embed.record", record: 42 }, { $type: "app.bsky.embed.recordWithMedia", record: null, media: "no" }]) {
      const [block] = socialBlocks(
        content,
        lookup({ ...resolved, [post]: { ...resolved[post], embed, labels: "bad" } }),
      );
      expect(block?.post).toMatchObject({ images: [], external: null, video: null, quote: null, mediaHidden: false });
    }
    const [untitled] = socialBlocks(
      content,
      lookup({
        ...resolved,
        [post]: {
          ...resolved[post],
          embed: { $type: "app.bsky.embed.external", external: { uri: "https://example.com/y", title: "  ", description: "d" } },
        },
      }),
    );
    expect(untitled?.post.external).toEqual({
      href: "https://example.com/y",
      title: "https://example.com/y",
      description: "d",
      imageUrl: null,
    });
  });

  it("keeps external previews and video posters, and never plays the video", () => {
    const records = lookup({
      ...resolved,
      [post]: {
        ...resolved[post],
        embed: {
          $type: "app.bsky.embed.external",
          external: {
            uri: "https://example.com/article",
            title: " Title ",
            description: "",
            thumb: blob("bafythumb"),
          },
        },
      },
      [quote]: {
        $type: "app.bsky.feed.post",
        text: "video",
        createdAt: "2026-07-15T22:08:33.054Z",
        embed: {
          $type: "app.bsky.embed.video",
          video: { $type: "blob", ref: { $link: "bafyvideo" }, mimeType: "video/mp4" },
          aspectRatio: { width: 16, height: 9 },
        },
      },
    });
    const [external, video] = socialBlocks(
      leaflet([
        { $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } },
        { $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: quote, cid: "bafy" } },
      ]),
      records,
    );
    expect(external?.post.external).toEqual({
      href: "https://example.com/article",
      title: "Title",
      description: null,
      imageUrl: expect.stringContaining("/feed_thumbnail/"),
    });
    expect(video?.post.video).toEqual({
      thumbnailUrl: `https://video.bsky.app/watch/${encodeURIComponent(quoter)}/bafyvideo/thumbnail.jpg`,
      aspectRatio: { width: 16, height: 9 },
    });
  });

  it("nests one level of quoted post and stops there", () => {
    const records = lookup({
      ...resolved,
      [post]: {
        ...resolved[post],
        embed: {
          $type: "app.bsky.embed.recordWithMedia",
          record: { $type: "app.bsky.embed.record", record: { uri: quote, cid: "bafy" } },
          media: {
            $type: "app.bsky.embed.images",
            images: [{ image: blob("bafymedia"), alt: "Media" }],
          },
        },
      },
      [quote]: {
        $type: "app.bsky.feed.post",
        text: "quoted",
        createdAt: "2026-07-15T22:08:33.054Z",
        embed: { $type: "app.bsky.embed.record", record: { uri: post, cid: "bafy" } },
      },
      [`at://${quoter}/app.bsky.actor.profile/self`]: {
        $type: "app.bsky.actor.profile",
        displayName: "Quoter",
      },
    });
    const [block] = socialBlocks(
      leaflet([{ $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } }]),
      records,
    );
    expect(block?.post.images.map((image) => image.alt)).toEqual(["Media"]);
    const quoted = block?.post.quote as Extract<ReaderBlock, { kind: "socialPost" }>;
    expect(quoted).toMatchObject({
      kind: "socialPost",
      post: {
        uri: quote,
        author: { name: "Quoter", handle: null },
        quote: null,
      },
    });
    expect(quoted.post.text).toEqual([
      { kind: "text", text: "quoted", marks: {}, link: null },
    ]);
  });
});

describe("pckt note cards", () => {
  const blogNote = {
    $type: "blog.pckt.mini.post",
    text: "Oh wow ! This is cool :)",
    createdAt: "2026-07-02T07:37:34.913Z",
    publication: blog,
  };
  const publication = {
    $type: "site.standard.publication",
    name: "Author’s Blog",
    url: "https://author.example/",
    icon: blob("bafyicon"),
  };

  it("ignores a publication pointer at a non-publication collection", () => {
    const records = lookup({ ...resolved, [note]: { ...blogNote, publication: post } });
    const [block] = socialBlocks(
      pckt([{ $type: "blog.pckt.block.noteEmbed", noteRef: { uri: note, cid: "bafy" } }]),
      records,
    );
    expect(block?.post).toMatchObject({ siteUrl: null, author: { name: "Author" } });
    expect(socialPostReferences(note, records)).toEqual([profile, author]);
  });

  it("reads handles only from at:// aliases of safe shape", () => {
    expect(handleFromDidDocument({ alsoKnownAs: ["https://example.com", "at://alice.example"] })).toBe("alice.example");
    expect(handleFromDidDocument({ alsoKnownAs: ["https://example.com"] })).toBeNull();
    expect(handleFromDidDocument({ alsoKnownAs: ["at://bad handle/with space"] })).toBeNull();
    expect(handleFromDidDocument("not a document")).toBeNull();
  });

  it("voices a blog note as the blog with a Visit blog destination", () => {
    const [block] = socialBlocks(
      pckt([{ $type: "blog.pckt.block.noteEmbed", noteRef: { uri: note, cid: "bafy" } }]),
      lookup({ ...resolved, [note]: blogNote, [blog]: publication }),
    );
    expect(block?.post).toMatchObject({
      platform: "pckt",
      url: `https://pckt.blog/n/${author}/note`,
      siteUrl: "https://author.example",
      author: {
        handle: "author.example",
        name: "Author’s Blog",
        avatarUrl: expect.stringContaining("bafyicon"),
        url: "https://author.example",
      },
    });
  });

  it("voices a personal note as the profile and quotes a document as a row card", () => {
    const [block] = socialBlocks(
      pckt([{ $type: "blog.pckt.block.noteEmbed", noteRef: { uri: note, cid: "bafy" } }]),
      lookup({
        ...resolved,
        [note]: {
          ...blogNote,
          publication: undefined,
          embed: {
            $type: "blog.pckt.mini.post#record",
            record: { uri: document, cid: "bafy" },
            start: 0,
            end: 10,
          },
        },
        [document]: {
          $type: "site.standard.document",
          site: "https://quoter.example",
          title: "Quoted article",
          path: "/quoted",
          publishedAt: "2026-07-01T00:00:00Z",
        },
      }),
    );
    expect(block?.post).toMatchObject({
      siteUrl: null,
      author: { name: "Author", url: `https://bsky.app/profile/${author}` },
      quote: {
        kind: "recordPreview",
        card: { title: "Quoted article", url: "https://quoter.example/quoted", size: "row" },
      },
    });
  });

  it("falls back to a row card to the note while the snapshot is absent", () => {
    const document = deriveResolvedContent(
      pckt([{ $type: "blog.pckt.block.noteEmbed", noteRef: { uri: note, cid: "bafy" } }]),
      author,
    );
    expect(document?.blocks[0]).toMatchObject({
      kind: "recordPreview",
      card: { url: `https://pckt.blog/n/${author}/note`, title: "Note on pckt" },
    });
  });

  it("keeps reposts and unknown collections on the inspector row", () => {
    const repost = `at://${author}/blog.pckt.mini.repost/r`;
    const document = deriveResolvedContent(
      pckt([{ $type: "blog.pckt.block.noteEmbed", noteRef: { uri: repost, cid: "bafy" } }]),
      author,
      lookup({ [repost]: { $type: "blog.pckt.mini.repost" } }),
    );
    expect(document?.blocks[0]).toMatchObject({
      kind: "recordPreview",
      card: { title: "Embedded record", url: `https://pdsls.dev/${repost}` },
    });
  });
});

describe("reference hops", () => {
  it("discovers Bluesky embeds as direct references", () => {
    expect(
      discoverReferences(
        leaflet([{ $type: "pub.leaflet.blocks.bskyPost", postRef: { uri: post, cid: "bafy" } }]),
        author,
      ),
    ).toEqual([post]);
  });

  it("names the author, handle, blog and quote hops only once the post resolved", () => {
    expect(socialPostReferences(post, () => undefined)).toEqual([]);
    expect(
      socialPostReferences(
        note,
        lookup({
          [note]: {
            ...resolved[post],
            publication: blog,
            embed: { $type: "blog.pckt.mini.post#record", record: { uri: quote, cid: "bafy" } },
          },
        }),
      ),
    ).toEqual([profile, author, blog, quote]);
    expect(socialPostReferences(blog, lookup({ [blog]: {} }))).toEqual([]);
  });

  it("walks hops without repeating known references, capped like the direct set", () => {
    const records = lookup({
      [post]: {
        ...resolved[post],
        embed: { $type: "app.bsky.embed.record", record: { uri: quote, cid: "bafy" } },
      },
      [quote]: { $type: "app.bsky.feed.post", text: "q", createdAt: "2026-07-15T22:08:33.054Z" },
    });
    const first = nextReferenceHop([post], new Set([post]), records);
    expect(first).toEqual([profile, author, quote]);
    const second = nextReferenceHop(first, new Set([post, ...first]), records);
    expect(second).toEqual([`at://${quoter}/app.bsky.actor.profile/self`, quoter]);
    const many = Array.from({ length: 20 }, (_, index) => `at://did:plc:p${index}/app.bsky.feed.post/x`);
    const wide = lookup(Object.fromEntries(many.map((uri) => [uri, resolved[post]])));
    const capped = nextReferenceHop(many, new Set(many), wide);
    expect(capped).toHaveLength(16);
    // The cap is over the hop set in encounter order: eight authors' profile and DID pairs.
    expect(capped).toEqual(
      many.slice(0, 8).flatMap((uri) => {
        const did = uri.slice("at://".length, uri.indexOf("/app.bsky"));
        return [`at://${did}/app.bsky.actor.profile/self`, did];
      }),
    );
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ReaderDocument, ReaderSocialPost } from "@serial/standard-site";
import { ReaderDocumentContent } from "~/components/content-reader/ReaderDocumentContent";
import { getElements } from "~/lib/hooks/useArticleNavigation";

vi.mock("~/lib/hooks/useFlagState", () => ({ useFlagState: () => ["iframe"] }));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));
vi.mock("~/components/feed/read/ArticleImageLightbox", () => ({
  ArticleImageLightbox: () => {
    throw new Error("Card images must not open the lightbox");
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const author = {
  did: "did:plc:author",
  handle: "author.example",
  name: "Author",
  avatarUrl:
    "https://cdn.bsky.app/img/avatar/plain/did:plc:author/bafyavatar@jpeg",
  url: "https://bsky.app/profile/did:plc:author",
};
const post: ReaderSocialPost = {
  platform: "bluesky",
  uri: "at://did:plc:author/app.bsky.feed.post/p",
  url: "https://bsky.app/profile/did:plc:author/post/p",
  author,
  siteUrl: null,
  text: [
    { kind: "text", text: "hello ", marks: {}, link: null },
    {
      kind: "text",
      text: "example",
      marks: {},
      link: { href: "https://example.com/", record: null },
    },
  ],
  createdAt: "2026-07-15T22:08:33.054Z",
  images: [
    {
      url: "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:author/bafyone@jpeg",
      alt: "One",
      title: null,
      aspectRatio: { width: 4, height: 3 },
      width: null,
      fullBleed: false,
    },
  ],
  external: null,
  video: null,
  quote: null,
  mediaHidden: false,
};
function document(blocks: ReaderDocument["blocks"]): ReaderDocument {
  return { blocks, footnotes: [], truncated: false };
}
function render(doc: ReaderDocument) {
  const container = window.document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(ReaderDocumentContent, {
        document: doc,
        documentUrl: "https://example.com/post",
        originActionLabel: "Open in Website",
        externalContent: "show",
      }),
    ),
  );
  return { container, unmount: () => act(() => root.unmount()) };
}
const links = (container: HTMLElement) =>
  [...container.querySelectorAll("a")].map((link) => [
    link.getAttribute("href"),
    link.textContent?.trim(),
  ]);

describe("social post cards", () => {
  it("draws a Bluesky post as a static card with author, text links, media and a footer", () => {
    const { container, unmount } = render(
      document([{ kind: "socialPost", post, source: null, align: null }]),
    );
    const card = container.querySelector('[data-social-post="bluesky"]')!;
    expect(card.tagName).toBe("DIV");
    expect(card.getAttribute("role")).toBe("note");
    expect(links(container)).toEqual([
      [
        "https://bsky.app/profile/did:plc:author/post/p",
        "Open post on Bluesky",
      ],
      ["https://bsky.app/profile/did:plc:author", "Author@author.example"],
      ["https://example.com/", "example"],
    ]);
    // The post link is the card's own; the author link sits in the header.
    expect(
      card.querySelector(":scope > a[data-social-post-link]"),
    ).not.toBeNull();
    expect(
      card.querySelector(
        "[data-social-post-header] > a[data-social-post-author]",
      ),
    ).not.toBeNull();
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-07-15T22:08:33.054Z",
    );
    expect(card.querySelector("time")?.textContent).toMatch(/ago$/);
    const image = card.querySelector<HTMLImageElement>(
      "[data-social-post-image]",
    )!;
    expect(image.alt).toBe("One");
    expect(image.style.aspectRatio).toBe("4 / 3");
    expect(card.querySelector("[data-social-post-avatar]")?.tagName).toBe(
      "IMG",
    );
    expect(getElements(container)).toEqual([card]);
    unmount();
  });

  it("draws the external preview as a link card and the video as a poster link", () => {
    const { container, unmount } = render(
      document([
        {
          kind: "socialPost",
          source: null,
          align: null,
          post: {
            ...post,
            images: [],
            external: {
              href: "https://example.com/article",
              title: "An article",
              description: "About things",
              imageUrl:
                "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:author/bafythumb@jpeg",
            },
            video: {
              thumbnailUrl:
                "https://video.bsky.app/watch/did%3Aplc%3Aauthor/bafyvideo/thumbnail.jpg",
              playlistUrl:
                "https://video.bsky.app/watch/did%3Aplc%3Aauthor/bafyvideo/playlist.m3u8",
              alt: "",
              aspectRatio: { width: 16, height: 9 },
              gif: false,
              captions: [],
            },
          },
        },
      ]),
    );
    const external = container.querySelector<HTMLAnchorElement>(
      "[data-reader-link-card]",
    )!;
    expect(external.href).toBe("https://example.com/article");
    expect(
      external.querySelector('[data-record-image="cover"]'),
    ).not.toBeNull();
    expect(external.textContent).toContain("An article");
    const video = container.querySelector("[data-social-post-video]")!;
    expect(video.tagName).toBe("DIV");
    {
      // The player holds the poster and a play button; the stream attaches on first play.
      const player = video.querySelector<HTMLElement>(
        "[data-social-post-video-player='video']",
      )!;
      expect(player.getAttribute("data-social-post-video-state")).toBe(
        "poster",
      );
      expect(player.style.aspectRatio).toBe("16 / 9");
      const media = player.querySelector("video")!;
      expect(media.getAttribute("src")).toBeNull();
      expect(media.getAttribute("preload")).toBe("none");
      expect(
        player
          .querySelector("[data-social-post-video-toggle]")
          ?.getAttribute("aria-label"),
      ).toBe("Play video");
      expect(player.querySelector("img")?.getAttribute("src")).toContain(
        "/thumbnail.jpg",
      );
    }
    unmount();
  });

  it("voices a pckt note as its blog, nests one quote, and reports hidden media", () => {
    const quoted: ReaderSocialPost = {
      ...post,
      uri: "at://did:plc:quoter/app.bsky.feed.post/q",
      url: "https://bsky.app/profile/did:plc:quoter/post/q",
      author: {
        ...author,
        did: "did:plc:quoter",
        name: "Quoter",
        handle: null,
        url: "https://bsky.app/profile/did:plc:quoter",
      },
      images: [],
      text: [{ kind: "text", text: "quoted", marks: {}, link: null }],
    };
    const note: ReaderSocialPost = {
      ...post,
      platform: "pckt",
      uri: "at://did:plc:author/blog.pckt.mini.post/n",
      url: "https://pckt.blog/n/did:plc:author/n",
      author: {
        ...author,
        name: "Author’s Blog",
        url: "https://author.example",
      },
      siteUrl: "https://author.example",
      text: [{ kind: "text", text: "note", marks: {}, link: null }],
      images: [],
      mediaHidden: true,
      quote: { kind: "socialPost", post: quoted, source: null, align: null },
    };
    const { container, unmount } = render(
      document([{ kind: "socialPost", post: note, source: null, align: null }]),
    );
    expect(links(container)).toEqual([
      ["https://pckt.blog/n/did:plc:author/n", "Open post on pckt"],
      ["https://author.example", "Author’s Blog@author.example"],
      [
        "https://bsky.app/profile/did:plc:quoter/post/q",
        "Open post on Bluesky",
      ],
      ["https://bsky.app/profile/did:plc:quoter", "Quoter"],
    ]);
    expect(
      container.querySelector("[data-social-post-hidden]")?.textContent,
    ).toContain("hidden");
    expect(container.querySelectorAll("[data-social-post]")).toHaveLength(2);
    expect(getElements(container)).toHaveLength(1);
    unmount();
  });

  it("drops a failed avatar or image without leaving a gap", () => {
    const { container, unmount } = render(
      document([{ kind: "socialPost", post, source: null, align: null }]),
    );
    act(() =>
      container
        .querySelector("[data-social-post-image]")!
        .dispatchEvent(new Event("error")),
    );
    expect(container.querySelector("[data-social-post-image]")).toBeNull();
    expect(container.querySelector("[data-social-post-images]")).not.toBeNull();
    unmount();
  });
});

// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { getDefaultStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReaderBlock,
  ReaderBlockValue,
  ReaderDocument,
  ReaderImage,
  ReaderInline,
} from "@serial/standard-site";
import { ReaderDocumentContent } from "~/components/content-reader/ReaderDocumentContent";
import {
  SANDBOXED_FRAME_SANDBOX,
  sandboxedFrameDocument,
} from "~/components/content-reader/SandboxedFrame";
import { connectionStateAtom } from "~/lib/data/atoms";
import { getElements } from "~/lib/hooks/useArticleNavigation";

vi.mock("~/lib/hooks/useFlagState", () => ({ useFlagState: () => ["iframe"] }));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function render(
  document: ReaderDocument,
  options: { simplified?: boolean } = {},
) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ReaderDocumentContent, {
        document,
        documentUrl: "https://example.com/post",
        originActionLabel: "Open in Website",
        ...options,
      }),
    ),
  );
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  window.document.body.innerHTML = "";
  getDefaultStore().set(connectionStateAtom, "unknown");
});

const text = (value: string): ReaderInline => ({
  kind: "text",
  text: value,
  marks: {},
  link: null,
});

function block(
  value: ReaderBlockValue & { align?: ReaderBlock["align"] },
): ReaderBlock {
  return { source: null, align: null, ...value };
}

const readerImage = (url: string): ReaderImage => ({
  url,
  alt: "",
  title: null,
  aspectRatio: null,
  width: null,
  fullBleed: false,
});

function document(
  blocks: ReaderBlock[],
  footnotes: ReaderDocument["footnotes"] = [],
): ReaderDocument {
  return { blocks, footnotes, truncated: false };
}

describe("Reader document content", () => {
  it("emits the navigable block shapes the progress index reads", () => {
    const container = render(
      document([
        block({ kind: "heading", level: 2, content: [text("Heading")] }),
        block({ kind: "paragraph", content: [text("Body")] }),
        block({
          kind: "quotation",
          children: [block({ kind: "paragraph", content: [text("Quoted")] })],
        }),
        block({
          kind: "list",
          ordered: true,
          start: 3,
          items: [
            {
              content: [block({ kind: "paragraph", content: [text("one")] })],
              checked: null,
            },
            {
              content: [block({ kind: "paragraph", content: [text("two")] })],
              checked: true,
            },
          ],
        }),
        block({
          kind: "image",
          image: {
            url: "https://example.com/a.png",
            alt: "A",
            title: null,
            aspectRatio: { width: 4, height: 3 },
            width: { value: 50, unit: "%" },
            fullBleed: false,
          },
          caption: [text("Caption")],
          align: "center",
        }),
        block({ kind: "divider" }),
        block({
          kind: "embed",
          href: "https://youtu.be/d-H1nzWHLoI",
          embedUrl: null,
          youtube: { videoId: "d-H1nzWHLoI", start: "5" },
          height: null,
          aspectRatio: null,
        }),
      ]),
    );
    const elements = getElements(container);
    expect(elements.map((element) => element.tagName)).toEqual([
      "H2",
      "P",
      "BLOCKQUOTE",
      "LI",
      "LI",
      "FIGURE",
      "DIV",
    ]);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(container.querySelector("li.task-list-item input")).toBeTruthy();
    // The frame carries the layout hints so the space is held before the image loads.
    const frame = container.querySelector<HTMLElement>(
      "figure [data-image-frame]",
    )!;
    expect(frame.style.aspectRatio).toBe("4 / 3");
    expect(frame.style.maxWidth).toBe("50%");
    expect(
      container.querySelector("figure")?.getAttribute("data-reader-align"),
    ).toBe("center");
    expect(container.querySelector("figcaption")?.textContent).toBe("Caption");
    expect(
      container
        .querySelector("[data-article-video-embed] iframe")
        ?.getAttribute("src"),
    ).toContain("start=5");
  });

  it("links footnote references to an endnotes section the sidebar reads", () => {
    const container = render(
      document(
        [
          block({
            kind: "paragraph",
            content: [text("Claim"), { kind: "footnote", number: 1 }],
          }),
        ],
        [{ number: 1, content: [text("Evidence")] }],
      ),
    );
    const reference = container.querySelector<HTMLAnchorElement>("sup a")!;
    expect(reference.getAttribute("href")).toBe("#fn-1");
    expect(reference.id).toBe("fnref-1");
    // The sidebar copies this text as the note's label, so it is the bare number.
    expect(reference.textContent).toBe("1");
    const note = container.querySelector('[role="doc-endnotes"] li#fn-1')!;
    expect(note.textContent).toContain("Evidence");
    expect(
      note.querySelector('a[role="doc-backlink"]')?.getAttribute("href"),
    ).toBe("#fnref-1");
  });

  it("draws callouts with a validated tint and grids with their layout", () => {
    const container = render(
      document([
        block({
          kind: "callout",
          emoji: "💡",
          color: "rgb(1 2 3)",
          tint: "rgb(1 2 3)",
          content: [text("Tip")],
        }),
        block({
          kind: "callout",
          emoji: null,
          color: "url(x)",
          tint: null,
          content: [text("Plain")],
        }),
        block({
          kind: "imageGroup",
          images: [
            readerImage("https://example.com/1.png"),
            readerImage("https://example.com/2.png"),
            readerImage("https://example.com/3.png"),
          ],
          title: null,
          caption: null,
          layout: { mode: "grid", columns: 2, ratio: "mosaic" },
        }),
      ]),
    );
    const [tinted, plain] = container.querySelectorAll<HTMLElement>(
      "[data-reader-callout]",
    );
    expect(tinted?.style.getPropertyValue("--reader-callout-tint")).toBe(
      "rgb(1 2 3)",
    );
    expect(tinted?.textContent).toContain("💡");
    expect(plain?.style.getPropertyValue("--reader-callout-tint")).toBe("");
    const grid = container.querySelector<HTMLElement>(
      "[data-reader-image-group='grid']",
    )!;
    expect(grid.getAttribute("data-reader-grid-ratio")).toBe("mosaic");
    expect(grid.style.getPropertyValue("--reader-grid-columns")).toBe("2");
    expect(grid.querySelectorAll("img")).toHaveLength(3);
  });

  it("renders notices with the specific reason for screen readers and one origin button", () => {
    const container = render(
      document([
        block({ kind: "notice", reason: "membersOnly" }),
        block({
          kind: "embed",
          href: "https://codepen.io/pen",
          embedUrl: "https://codepen.io/pen/embed",
          youtube: null,
          height: 300,
          aspectRatio: null,
        }),
        {
          kind: "hologram",
          source: null,
          align: null,
        } as unknown as ReaderBlock,
      ]),
    );
    const notices = container.querySelectorAll<HTMLElement>("[role='note']");
    // Each notice is one atomic stop for the progress index, not two.
    expect(getElements(container)).toHaveLength(3);
    expect(notices).toHaveLength(3);
    expect(notices[0]?.getAttribute("data-reader-notice")).toBe("membersOnly");
    expect(
      notices[0]?.querySelector("[data-reader-notice-headline]")?.textContent,
    ).toBe("The rest of this post is for members");
    expect(notices[1]?.getAttribute("data-reader-notice")).toBe("embed");
    expect(
      notices[1]?.querySelector("[data-reader-notice-headline]")?.textContent,
    ).toBe("This interactive content is available on the original site");
    expect(notices[0]?.querySelector(".sr-only")?.textContent).toContain(
      "members",
    );
    expect(notices[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/post",
    );
    expect(notices[0]?.querySelector("a")?.textContent).toContain(
      "Open in Website",
    );
    // A src frame's notice opens the document page, never the embed's own URL.
    expect(notices[1]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/post",
    );
    expect(notices[2]?.getAttribute("data-reader-notice")).toBe("unsupported");
    expect(
      notices[2]?.querySelector("[data-reader-notice-headline]")?.textContent,
    ).toBe("Available on the original site");
    expect(container.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("sandboxes authored HTML in one locked-down frame and shows the notice offline or simplified", () => {
    const html = block({
      kind: "html",
      html: "<p>Page</p><script>alert(1)</script>",
      height: 243,
      aspectRatio: null,
    });
    const online = render(document([html]));
    const frame = online.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe(SANDBOXED_FRAME_SANDBOX);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("allow")).toContain("camera 'none'");
    expect(frame.getAttribute("csp")).toContain("default-src 'none'");
    expect(frame.style.height).toBe("243px");
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).toBe(
      sandboxedFrameDocument("<p>Page</p><script>alert(1)</script>"),
    );
    expect(srcdoc).toContain('<base target="_blank">');
    expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');

    act(() => getDefaultStore().set(connectionStateAtom, "disconnected"));
    const offline = render(document([html]));
    expect(offline.querySelector("iframe")).toBeNull();
    expect(offline.querySelector("[data-reader-notice='frame']")).toBeTruthy();
    act(() => getDefaultStore().set(connectionStateAtom, "connected"));
    const simplified = render(document([html]), { simplified: true });
    expect(simplified.querySelector("iframe")).toBeNull();
    expect(
      simplified.querySelector("[data-reader-notice='frame']"),
    ).toBeTruthy();
  });

  it("uses the aspect ratio hint or the default height for frames without a height", () => {
    const ratio = render(
      document([
        block({
          kind: "html",
          html: "<p>x</p>",
          height: null,
          aspectRatio: { width: 16, height: 9 },
        }),
      ]),
    );
    expect(ratio.querySelector("iframe")?.style.aspectRatio).toBe("16 / 9");
    const fallback = render(
      document([
        block({
          kind: "html",
          html: "<p>x</p>",
          height: null,
          aspectRatio: null,
        }),
      ]),
    );
    expect(fallback.querySelector("iframe")?.style.height).toBe("480px");
  });

  it("renders link cards as a row with the preview beside the copy", () => {
    const container = render(
      document([
        block({
          kind: "linkCard",
          href: "https://www.example.com/support",
          title: "Support",
          description: "Chip in",
          imageUrl: "https://example.com/preview.png",
        }),
        block({
          kind: "linkCard",
          href: "https://example.com/plain",
          title: "Plain",
          description: null,
          imageUrl: null,
        }),
      ]),
    );
    const cards = container.querySelectorAll<HTMLAnchorElement>(
      "[data-reader-link-card]",
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]!.href).toBe("https://www.example.com/support");
    expect(cards[0]!.target).toBe("_blank");
    expect(cards[0]!.rel).toBe("noopener noreferrer");
    expect(
      cards[0]!
        .querySelector('[data-record-image="cover"]')
        ?.getAttribute("src"),
    ).toBe("https://example.com/preview.png");
    expect(cards[0]!.querySelector("[data-record-title]")?.textContent).toBe(
      "Support",
    );
    expect(
      cards[0]!.querySelector("[data-record-description]")?.textContent,
    ).toBe("Chip in");
    expect(cards[0]!.querySelector("[data-record-metadata]")?.textContent).toBe(
      "example.com",
    );
    expect(cards[1]!.querySelector('[data-record-image="cover"]')).toBeNull();
    expect(cards[1]!.querySelector("[data-record-description]")).toBeNull();
  });

  it("draws natural grids with each image's own shape and a bold gallery title", () => {
    const container = render(
      document([
        block({
          kind: "imageGroup",
          images: [
            {
              ...readerImage("https://example.com/left.webp"),
              alt: "Left sidebar",
              aspectRatio: { width: 387, height: 562 },
            },
            {
              ...readerImage("https://example.com/right.webp"),
              alt: "Right sidebar",
              aspectRatio: { width: 379, height: 573 },
            },
          ],
          title: "Sidebars",
          caption: null,
          layout: { mode: "grid", columns: 2, ratio: null },
        }),
      ]),
    );
    const grid = container.querySelector<HTMLElement>(
      "[data-reader-image-group='grid']",
    )!;
    expect(grid.hasAttribute("data-reader-grid-ratio")).toBe(false);
    expect(grid.style.getPropertyValue("--reader-grid-columns")).toBe("2");
    expect(grid.style.getPropertyValue("--reader-grid-columns-narrow")).toBe(
      "2",
    );
    expect(
      grid.querySelector("[data-reader-image-group-title]")?.textContent,
    ).toBe("Sidebars");
    const cells = grid.querySelectorAll<HTMLElement>(
      "[data-reader-image-group-items] > *",
    );
    expect([...cells].map((cell) => cell.style.aspectRatio)).toEqual([
      "387 / 562",
      "379 / 573",
    ]);
    expect(grid.querySelectorAll("[data-lightbox-trigger]")).toHaveLength(2);
  });

  it("pages a carousel one slide at a time and opens the lightbox on the visible slide", () => {
    const container = render(
      document([
        block({
          kind: "imageGroup",
          images: [
            readerImage("https://example.com/1.png"),
            readerImage("https://example.com/2.png"),
            readerImage("https://example.com/3.png"),
          ],
          title: null,
          caption: [text("Three")],
          layout: { mode: "carousel" },
        }),
      ]),
    );
    const carousel = container.querySelector<HTMLElement>(
      "[data-reader-image-group='carousel']",
    )!;
    expect(
      carousel.querySelectorAll("[data-reader-carousel-slide]"),
    ).toHaveLength(3);
    const counter = () =>
      carousel.querySelector("[data-reader-carousel-counter]")?.textContent;
    const arrow = (direction: string) =>
      carousel.querySelector<HTMLButtonElement>(
        `[data-reader-carousel-arrow='${direction}']`,
      );
    expect(counter()).toBe("1 / 3");
    expect(arrow("previous")).toBeNull();
    const strip = carousel.querySelector<HTMLElement>(
      "[data-reader-carousel-strip]",
    )!;
    strip.scrollTo = () => {};
    act(() => arrow("next")!.click());
    act(() => arrow("next")!.click());
    expect(counter()).toBe("3 / 3");
    expect(arrow("next")).toBeNull();
    expect(arrow("previous")).not.toBeNull();

    const triggers = carousel.querySelectorAll<HTMLButtonElement>(
      "[data-lightbox-trigger]",
    );
    act(() => triggers[2]!.click());
    const dialog = window.document.querySelector("[role='dialog']")!;
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/3.png",
    );
    expect(dialog.querySelector("[data-lightbox-counter]")?.textContent).toBe(
      "3 / 3",
    );
    expect(dialog.querySelector("[data-lightbox-arrow='next']")).toBeNull();
    act(() =>
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      ),
    );
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/2.png",
    );
    act(() =>
      dialog
        .querySelector<HTMLButtonElement>("[data-lightbox-arrow='previous']")!
        .click(),
    );
    expect(dialog.querySelector("[data-lightbox-counter]")?.textContent).toBe(
      "1 / 3",
    );
    expect(dialog.querySelector("[data-lightbox-arrow='previous']")).toBeNull();
    // Paging the lightbox leaves the carousel where the reader left it.
    expect(counter()).toBe("3 / 3");
  });

  it("keeps a carousel interactive but without a lightbox in simplified mode", () => {
    const container = render(
      document([
        block({
          kind: "imageGroup",
          images: [
            readerImage("https://example.com/1.png"),
            readerImage("https://example.com/2.png"),
          ],
          title: null,
          caption: null,
          layout: { mode: "carousel" },
        }),
      ]),
      { simplified: true },
    );
    expect(container.querySelector("[data-lightbox]")).toBeNull();
    expect(
      container.querySelector("[data-reader-carousel-arrow='next']"),
    ).not.toBeNull();
    expect(
      container.querySelectorAll("[data-reader-carousel-slide] img"),
    ).toHaveLength(2);
  });

  it("holds a muted frame for each body image until it loads", () => {
    const container = render(
      document([
        block({
          kind: "image",
          image: {
            ...readerImage("https://example.com/known.png"),
            aspectRatio: { width: 4, height: 5 },
          },
          caption: null,
        }),
        block({
          kind: "image",
          image: readerImage("https://example.com/unknown.png"),
          caption: null,
        }),
      ]),
    );
    const frames =
      container.querySelectorAll<HTMLElement>("[data-image-frame]");
    expect(frames).toHaveLength(2);
    expect(frames[0]!.getAttribute("data-image-frame")).toBe("loading");
    expect(frames[0]!.style.aspectRatio).toBe("4 / 5");
    // Unknown shapes reserve a landscape frame rather than collapsing to nothing.
    expect(frames[1]!.style.aspectRatio).toBe("3 / 2");
    act(() =>
      frames[0]!.querySelector("img")!.dispatchEvent(new Event("load")),
    );
    expect(frames[0]!.getAttribute("data-image-frame")).toBe("loaded");
    expect(frames[1]!.getAttribute("data-image-frame")).toBe("loading");
  });

  it("keeps images plain and videos as links in simplified mode", () => {
    const container = render(
      document([
        block({
          kind: "image",
          image: {
            url: "https://example.com/a.png",
            alt: "A",
            title: null,
            aspectRatio: null,
            width: null,
            fullBleed: false,
          },
          caption: null,
        }),
        block({
          kind: "embed",
          href: "https://youtu.be/d-H1nzWHLoI",
          embedUrl: null,
          youtube: { videoId: "d-H1nzWHLoI", start: null },
          height: null,
          aspectRatio: null,
        }),
      ]),
      { simplified: true },
    );
    expect(container.querySelector("[data-lightbox]")).toBeNull();
    expect(container.querySelector("figure img")?.getAttribute("src")).toBe(
      "https://example.com/a.png",
    );
    expect(container.querySelector("[data-article-video-embed]")).toBeNull();
    expect(container.querySelector("p > a")?.textContent).toBe(
      "Watch on YouTube",
    );
  });
});

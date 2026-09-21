// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ReaderBlock,
  ReaderBlockValue,
  ReaderDocument,
  ReaderInline,
} from "@serial/standard-site";
import { ReaderDocumentContent } from "~/components/content-reader/ReaderDocumentContent";
import {
  SANDBOXED_FRAME_SANDBOX,
  sandboxedFrameDocument,
} from "~/components/content-reader/SandboxedFrame";
import { getElements } from "~/lib/hooks/useArticleNavigation";

vi.mock("~/lib/hooks/useFlagState", () => ({ useFlagState: () => ["iframe"] }));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function render(
  document: ReaderDocument,
  options: { simplified?: boolean; offline?: boolean } = {},
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
    const image = container.querySelector<HTMLImageElement>("figure img")!;
    expect(image.style.aspectRatio).toBe("4 / 3");
    expect(image.style.maxWidth).toBe("50%");
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
    const note = container.querySelector('[role="doc-endnotes"] li#fn-1')!;
    expect(note.textContent).toContain("Evidence");
    expect(
      note.querySelector('a[role="doc-backlink"]')?.getAttribute("href"),
    ).toBe("#fnref-1");
  });

  it("draws callouts with a validated tint and grids with their layout", () => {
    const image = (url: string) => ({
      url,
      alt: "",
      title: null,
      aspectRatio: null,
      width: null,
      fullBleed: false,
    });
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
            image("https://example.com/1.png"),
            image("https://example.com/2.png"),
            image("https://example.com/3.png"),
          ],
          caption: null,
          layout: { mode: "grid", rows: 2, ratio: "mosaic" },
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
    expect(grid.getAttribute("data-reader-grid-rows")).toBe("2");
    expect(grid.getAttribute("data-reader-grid-ratio")).toBe("mosaic");
    // Three images in a two-row mosaic: the first spans both rows, two more stack beside it.
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
    const notices = container.querySelectorAll<HTMLElement>("[role='alert']");
    expect(notices).toHaveLength(3);
    expect(notices[0]?.getAttribute("data-reader-notice")).toBe("membersOnly");
    expect(
      notices[0]?.querySelector("[data-reader-notice-headline]")?.textContent,
    ).toBe("The rest of this post is for members");
    expect(
      notices[1]?.querySelector("[data-reader-notice-headline]")?.textContent,
    ).toBe("Available on the original site");
    expect(notices[0]?.querySelector(".sr-only")?.textContent).toContain(
      "members",
    );
    expect(notices[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/post",
    );
    expect(notices[0]?.querySelector("a")?.textContent).toContain(
      "Open in Website",
    );
    // A src frame points at the embed's own page until ticket 38 admits it.
    expect(notices[1]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://codepen.io/pen",
    );
    expect(notices[2]?.getAttribute("data-reader-notice")).toBe("unsupported");
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

    const offline = render(document([html]), { offline: true });
    expect(offline.querySelector("iframe")).toBeNull();
    expect(offline.querySelector("[data-reader-notice='frame']")).toBeTruthy();
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

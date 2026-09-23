import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { flattenReaderImages } from "~/components/content-reader/flattenReaderImages";
import { ArticleImageLightbox } from "~/components/feed/read/ArticleImageLightbox";
import { ArticleContent } from "~/components/feed/read/ArticleContent";

vi.mock("~/lib/hooks/useFlagState", () => ({ useFlagState: () => ["iframe"] }));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));

function renderReaderNodes(...nodes: ReactNode[]) {
  return renderToStaticMarkup(
    createElement("div", null, ...flattenReaderImages(nodes)),
  );
}

function expectInOrder(markup: string, ...values: string[]) {
  const positions = values.map((value) => markup.indexOf(value));

  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

describe("reader content images", () => {
  it.each([
    '<figure><img src="/garden.jpg" alt="Garden path"></figure>',
    '<div class="captioned-image-container"><img src="/garden.jpg" alt="Garden path"></div>',
    '<figure><picture><source srcset="/garden-wide.jpg 2x"><img src="/garden.jpg" alt="Garden path"></picture></figure>',
  ])("preserves alt text when replacing an image wrapper: %s", (content) => {
    const markup = renderToStaticMarkup(
      createElement(ArticleContent, { content }),
    );
    expect(markup).toContain('alt="Garden path"');
    expect(markup).toContain('aria-label="Open image preview: Garden path"');
  });

  it("preserves an image between paragraphs in a wrapped article", () => {
    const markup = renderReaderNodes(
      createElement(
        "article",
        null,
        createElement("p", null, "Paragraph before image"),
        createElement(ArticleImageLightbox, {
          src: "https://example.com/image.jpg",
          alt: "Article illustration",
        }),
        createElement("p", null, "Paragraph after image"),
      ),
    );

    expectInOrder(
      markup,
      "Paragraph before image",
      "Open image preview: Article illustration",
      "Paragraph after image",
    );
  });

  it("preserves multiple images among content in a main wrapper", () => {
    const markup = renderReaderNodes(
      createElement(
        "main",
        null,
        createElement("p", null, "Introduction"),
        createElement(ArticleImageLightbox, {
          src: "https://example.com/first.jpg",
          alt: "First illustration",
        }),
        createElement("p", null, "Discussion"),
        createElement(ArticleImageLightbox, {
          src: "https://example.com/second.jpg",
          alt: "Second illustration",
        }),
        createElement("p", null, "Conclusion"),
      ),
    );

    expectInOrder(
      markup,
      "Introduction",
      "Open image preview: First illustration",
      "Discussion",
      "Open image preview: Second illustration",
      "Conclusion",
    );
  });

  it("removes navigation wrapped around an image", () => {
    const markup = renderReaderNodes(
      createElement("p", null, "Before linked image"),
      createElement(
        "a",
        { href: "https://example.com/image-target" },
        "\n  ",
        createElement(
          "span",
          null,
          "\n",
          createElement(ArticleImageLightbox, {
            src: "https://example.com/image.jpg",
            alt: "Linked preview",
          }),
          "  ",
        ),
        "\n",
      ),
      createElement("p", null, "After linked image"),
    );

    expect(markup).toContain('aria-label="Open image preview: Linked preview"');
    expect(markup).not.toContain("image-target");
    expect(markup.match(/Open image preview: Linked preview/g)).toHaveLength(1);
    expectInOrder(
      markup,
      "Before linked image",
      "Open image preview: Linked preview",
      "After linked image",
    );
  });

  it("splits a mixed anchor around a non-navigating image", () => {
    const markup = renderReaderNodes(
      createElement(
        "a",
        { href: "https://example.com/article" },
        "Read before the image",
        createElement(ArticleImageLightbox, {
          src: "https://example.com/image.jpg",
          alt: "Mixed preview",
        }),
        "Read after the image",
      ),
    );

    expectInOrder(
      markup,
      "Read before the image",
      "Open image preview: Mixed preview",
      "Read after the image",
    );
    expect(markup).toContain(
      '<a href="https://example.com/article">Read before the image</a>',
    );
    expect(markup).toContain(
      '<a href="https://example.com/article">Read after the image</a>',
    );
  });

  it("leaves ordinary links unchanged", () => {
    const markup = renderReaderNodes(
      createElement(
        "a",
        { href: "https://example.com/article" },
        "Read the article",
      ),
    );

    expect(markup).toContain(
      '<a href="https://example.com/article">Read the article</a>',
    );
  });

  it("keeps a figure and its caption together", () => {
    const markup = renderReaderNodes(
      createElement(
        "article",
        null,
        createElement(
          "figure",
          null,
          createElement(ArticleImageLightbox, {
            src: "https://example.com/diagram.jpg",
            alt: "System diagram",
          }),
          createElement("figcaption", null, "How the system fits together"),
        ),
      ),
    );

    expect(markup).toContain("<figure>");
    expect(markup).toContain("</figcaption></figure>");
    expectInOrder(
      markup,
      "Open image preview: System diagram",
      "How the system fits together",
    );
  });
});

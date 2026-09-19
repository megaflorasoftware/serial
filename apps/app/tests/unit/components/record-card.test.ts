// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { recordCard, sanitizeArticleHtml } from "@serial/standard-site";
import { ArticleContent } from "~/components/feed/read/ArticleContent";

vi.mock("~/lib/hooks/useFlagState", () => ({ useFlagState: () => ["iframe"] }));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));
vi.mock("~/components/feed/read/ArticleImageLightbox", () => ({
  ArticleImageLightbox: () => {
    throw new Error("Card image must open the original, not the lightbox");
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const preview = {
  uri: "at://did:plc:alice/site.standard.document/post",
  url: "https://example.com/post",
  title: "Title",
  description: "Summary",
  imageUrl: "https://example.com/cover.jpg",
  publicationName: "Publication",
  iconUrl: "https://example.com/icon.png",
  author: "Author",
  publishedAt: "2026-09-18T00:00:00Z",
};
describe.each([false, true])("reader simplified=%s", (simplified) => {
  it.each(["small", "medium", "large", "row"])(
    "renders %s cards with safe links and metadata",
    (size) => {
      const container = document.createElement("div");
      const root = createRoot(container);
      act(() =>
        root.render(
          createElement(ArticleContent, {
            content: sanitizeArticleHtml(recordCard(preview, size)),
            simplified,
          }),
        ),
      );
      const link = container.querySelector<HTMLAnchorElement>(
        `[data-record-card="${size}"]`,
      )!;
      expect(link.href).toBe(preview.url);
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(link.textContent).toContain("Publication");
      expect(link.textContent).toContain("Author · Sep 18, 2026");
      expect(link.querySelectorAll('[data-record-image="cover"]')).toHaveLength(
        size === "small" ? 0 : 1,
      );
      expect(link.textContent?.includes("Summary")).toBe(size !== "small");
      expect(container.querySelectorAll("a")).toHaveLength(1);
      act(() => root.unmount());
    },
  );
  it("keeps ordinary inline mentions and contains failed images", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(ArticleContent, {
          content:
            recordCard(preview, "large") +
            '<p>A <a href="https://example.com/mention">mention</a>.</p>',
          simplified,
        }),
      ),
    );
    act(() =>
      container
        .querySelector('[data-record-image="cover"]')!
        .dispatchEvent(new Event("error")),
    );
    expect(container.querySelector('[data-record-image="cover"]')).toBeNull();
    expect(container.textContent).toContain("Title");
    const mention = container.querySelector("p > a")!;
    expect(mention.textContent).toBe("mention");
    expect(mention.attributes.getNamedItem("class")).toBeNull();
    act(() => root.unmount());
  });
});

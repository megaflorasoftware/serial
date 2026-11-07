// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { recordCard } from "@serial/standard-site";
import type { ReaderDocument } from "@serial/standard-site";
import { ReaderDocumentContent } from "~/components/content-reader/ReaderDocumentContent";

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
describe("reader record cards", () => {
  it.each(["small", "medium", "large", "row"] as const)(
    "renders %s cards with safe links and metadata",
    (size) => {
      const card = recordCard(preview, size)!;
      const { container, unmount } = render(
        document([{ kind: "recordPreview", card, source: null, align: null }]),
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
      unmount();
    },
  );
  it("keeps ordinary inline mentions and contains failed images", () => {
    const card = recordCard(preview, "large")!;
    const { container, unmount } = render(
      document([
        { kind: "recordPreview", card, source: null, align: null },
        {
          kind: "paragraph",
          source: null,
          align: null,
          content: [
            { kind: "text", text: "A ", marks: {}, link: null },
            {
              kind: "text",
              text: "mention",
              marks: {},
              link: {
                href: "https://example.com/mention",
                record: preview.uri,
              },
            },
            { kind: "text", text: ".", marks: {}, link: null },
          ],
        },
      ]),
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
    expect(mention.getAttribute("data-record-uri")).toBe(preview.uri);
    expect(mention.attributes.getNamedItem("class")).toBeNull();
    unmount();
  });
});

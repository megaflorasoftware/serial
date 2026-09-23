// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReaderBodySkeleton,
  ReaderSkeleton,
} from "~/components/content-reader/ReaderSkeleton";
import { getElements } from "~/lib/hooks/useArticleNavigation";

vi.mock("~/components/feed/watch/[id]/useZoom", () => ({
  useZoom: () => ({ zoom: 0 }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(element));
  return container;
}

describe("Reader skeleton", () => {
  it("draws three paragraphs that hold progress restoration and are not navigable", () => {
    const container = render(createElement(ReaderBodySkeleton));
    const pending = container.querySelector("[data-reader-content-pending]")!;
    expect(pending.children).toHaveLength(3);
    expect(getElements(container)).toHaveLength(0);
  });

  it("shows real source and header data when known and skeletons when not", () => {
    const unknown = render(createElement(ReaderSkeleton));
    expect(unknown.querySelector("h1")).toBeNull();
    expect(
      unknown.querySelectorAll("[data-serial-header][data-slot=skeleton]"),
    ).toHaveLength(2);

    const known = render(
      createElement(ReaderSkeleton, {
        source: { icon: null, name: "The Feed" },
        header: { title: "Article title", author: "Author" },
      }),
    );
    expect(known.querySelector("h1")?.textContent).toBe("Article title");
    expect(known.querySelector("h6")?.textContent).toBe("Author");
    expect(known.textContent).toContain("The Feed");
    expect(known.querySelector("[data-reader-content-pending]")).not.toBeNull();
  });
});

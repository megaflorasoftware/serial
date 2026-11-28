import { describe, expect, it, vi } from "vitest";
import {
  scrollArticleBlockToTarget,
  setArticleRestorationVisibility,
} from "~/lib/article-block-scroll";

function rect(input: { top: number; height: number }): DOMRect {
  return {
    top: input.top,
    bottom: input.top + input.height,
    height: input.height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: input.top,
    toJSON: () => ({}),
  };
}

function element(input: {
  tagName: string;
  top: number;
  height: number;
  containsImage?: boolean;
}) {
  return {
    tagName: input.tagName,
    style: { visibility: "" },
    getBoundingClientRect: () => rect(input),
    querySelector: () => (input.containsImage ? {} : null),
  } as unknown as HTMLElement;
}

function container() {
  const scrollTo = vi.fn();
  return {
    element: {
      scrollTop: 300,
      getBoundingClientRect: () => rect({ top: 40, height: 900 }),
      scrollTo,
    } as unknown as HTMLElement,
    scrollTo,
  };
}

describe("article block scroll placement", () => {
  it("places a text block's top edge one-sixth down the viewport", () => {
    const target = container();

    scrollArticleBlockToTarget(
      element({ tagName: "P", top: 640, height: 120 }),
      "instant",
      target.element,
    );

    expect(target.scrollTo).toHaveBeenCalledWith({
      top: 750,
      behavior: "instant",
    });
  });

  it.each([
    element({ tagName: "IMG", top: 640, height: 400 }),
    element({ tagName: "FIGURE", top: 640, height: 400 }),
    element({ tagName: "DIV", top: 640, height: 400, containsImage: true }),
  ])("places image blocks like text blocks", (block) => {
    const target = container();

    scrollArticleBlockToTarget(block, "instant", target.element);

    expect(target.scrollTo).toHaveBeenCalledWith({
      top: 750,
      behavior: "instant",
    });
  });

  it("keeps article content hidden until restoration completes", () => {
    const block = element({ tagName: "P", top: 640, height: 120 });

    setArticleRestorationVisibility(block, false);
    expect(block.style.visibility).toBe("hidden");

    setArticleRestorationVisibility(block, true);
    expect(block.style.visibility).toBe("");
  });
});

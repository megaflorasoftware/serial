// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { getDefaultStore } from "jotai";
import { afterEach, expect, it, vi } from "vitest";
import { ViewItemStandardList } from "~/components/feed/view-lists/ViewItemStandardList";
import { ViewItemLargeList } from "~/components/feed/view-lists/ViewItemLargeList";
import { ViewItemGrid } from "~/components/feed/view-lists/ViewItemGrid";
import { ViewItemLargeGrid } from "~/components/feed/view-lists/ViewItemLargeGrid";
import { selectedItemIdAtom } from "~/lib/data/atoms";

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("~/components/feed/view-lists/ItemDisplay", async () => {
  const { createElement } = await import("react");
  function Item({
    contentId,
    onSelect,
  }: {
    contentId: string;
    onSelect?: () => void;
  }) {
    renders.set(contentId, (renders.get(contentId) ?? 0) + 1);
    return createElement("button", { onClick: onSelect }, contentId);
  }
  return { ItemDisplay: Item, GridItemDisplay: Item };
});
vi.mock("~/lib/hooks/useFlipItems", () => ({
  useFlipItems: (items: string[]) => ({
    renderedItems: items,
    containerRef: undefined,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  getDefaultStore().set(selectedItemIdAtom, null);
  renders.clear();
});

it.each([
  ViewItemStandardList,
  ViewItemLargeList,
  ViewItemGrid,
  ViewItemLargeGrid,
])(
  "%s only rerenders changed selections when reconciliation preserves the visible items",
  (List) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    const select = vi.fn();
    const items = Array.from({ length: 30 }, (_, index) => `item-${index}`);
    act(() =>
      root.render(createElement(List, { items, handleMouseSelect: select })),
    );
    renders.clear();
    act(() =>
      root.render(
        createElement(List, { items: [...items], handleMouseSelect: select }),
      ),
    );
    expect([...renders.keys()]).toEqual([]);

    act(() => getDefaultStore().set(selectedItemIdAtom, "item-0"));
    expect([...renders.keys()]).toEqual(["item-0"]);
    act(() => container.querySelector("button")!.click());
    expect(select).toHaveBeenCalledWith("item-0");
  },
);

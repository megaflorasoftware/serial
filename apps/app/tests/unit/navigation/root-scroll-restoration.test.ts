import { describe, expect, it, vi } from "vitest";
import {
  getNextRootItemId,
  resolveRootRestorationAction,
  resolveRootRestorationItemId,
} from "~/lib/root-scroll-restoration";
import { scrollRootItemToTarget } from "~/lib/hooks/useScrollToFeedItem";

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

describe("root scroll restoration", () => {
  it("computes the immediate successor without falling backward", () => {
    const items = ["first", "selected", "next"];

    expect(getNextRootItemId(items, "selected")).toBe("next");
    expect(getNextRootItemId(items, "next")).toBeNull();
    expect(getNextRootItemId(items, "missing")).toBeNull();
    expect(getNextRootItemId(items, null)).toBeNull();
  });

  it("restores the selection, then its captured successor, then the top", () => {
    expect(
      resolveRootRestorationItemId({
        activeItemIds: ["selected", "next"],
        selectedItemId: "selected",
        successorItemId: "next",
      }),
    ).toBe("selected");

    expect(
      resolveRootRestorationItemId({
        activeItemIds: ["first", "next"],
        selectedItemId: "selected",
        successorItemId: "next",
      }),
    ).toBe("next");

    expect(
      resolveRootRestorationItemId({
        activeItemIds: ["first"],
        selectedItemId: "selected",
        successorItemId: "next",
      }),
    ).toBeNull();
  });

  it("selects then scrolls the restoration target during the initial pass", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: true,
        activeItemIds: ["first", "next"],
        selectedItemId: "selected",
        anchor: { selectedItemId: "selected", successorItemId: "next" },
      }),
    ).toEqual({ type: "select", itemId: "next" });

    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: true,
        activeItemIds: ["first", "next"],
        selectedItemId: "next",
        anchor: { selectedItemId: "selected", successorItemId: "next" },
      }),
    ).toEqual({ type: "scroll", itemId: "next" });
  });

  it("aborts the mount restoration when something else moves the selection", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: true,
        activeItemIds: ["first", "next", "hovered"],
        selectedItemId: "hovered",
        anchor: { selectedItemId: "selected", successorItemId: "next" },
        restorationSelection: "next",
      }),
    ).toEqual({ type: "abort" });
  });

  it("continues the mount restoration while its own selection holds", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: true,
        activeItemIds: ["first", "next"],
        selectedItemId: "next",
        anchor: { selectedItemId: "selected", successorItemId: "next" },
        restorationSelection: "next",
      }),
    ).toEqual({ type: "scroll", itemId: "next" });

    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: true,
        activeItemIds: ["first"],
        selectedItemId: null,
        anchor: { selectedItemId: "selected", successorItemId: "next" },
        restorationSelection: null,
      }),
    ).toEqual({ type: "scroll", itemId: null });
  });

  it("scrolls to the top on the initial pass only when nothing is restorable", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: true,
        activeItemIds: ["first"],
        selectedItemId: null,
        anchor: { selectedItemId: null, successorItemId: null },
      }),
    ).toEqual({ type: "scroll", itemId: null });
  });

  it("never scrolls or reselects when an anchored item leaves the live list", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: false,
        activeItemIds: ["first", "next"],
        selectedItemId: "selected",
        anchor: { selectedItemId: "selected", successorItemId: null },
      }),
    ).toEqual({ type: "none" });
  });

  it("recycles the anchor when the selection moves on", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: false,
        activeItemIds: ["first", "next"],
        selectedItemId: "next",
        anchor: { selectedItemId: "selected", successorItemId: null },
      }),
    ).toEqual({ type: "recycle-anchor" });
  });

  it("leaves a live selection untouched after the initial pass", () => {
    expect(
      resolveRootRestorationAction({
        isInitialRestorationPass: false,
        activeItemIds: ["first", "selected"],
        selectedItemId: "selected",
        anchor: { selectedItemId: "selected", successorItemId: null },
      }),
    ).toEqual({ type: "none" });
  });

  it("places the selected item's center one-third down the viewport", () => {
    const scrollTo = vi.fn();
    const container = {
      scrollTop: 300,
      getBoundingClientRect: () => rect({ top: 40, height: 900 }),
      scrollTo,
    } as unknown as HTMLElement;
    const item = {
      getBoundingClientRect: () => rect({ top: 640, height: 120 }),
    } as unknown as Element;

    scrollRootItemToTarget(item, "instant", container);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 660,
      behavior: "instant",
    });
  });
});

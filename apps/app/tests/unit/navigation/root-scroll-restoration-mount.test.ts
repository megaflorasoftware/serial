// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureRootScrollRestoration,
  captureRootScrollRestorationOnClick,
  createRootItemLinkClickHandler,
  useRootItemScrollRestoration,
} from "~/lib/root-scroll-restoration";

const mocks = vi.hoisted(() => ({
  getFeedItemElement: vi.fn<(itemId: string | null) => Element | null>(),
  scrollRootItemToTarget: vi.fn(),
  scrollTo: vi.fn(),
}));

vi.mock("~/lib/hooks/useScrollToFeedItem", () => ({
  getFeedItemElement: mocks.getFeedItemElement,
  scrollRootItemToTarget: mocks.scrollRootItemToTarget,
}));

vi.mock("~/lib/scroll", () => ({
  getScrollContainer: () => ({ scrollTo: mocks.scrollTo }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type ListProps = {
  activeItemIds: readonly string[];
  selectedItemId: string | null;
  setSelectedItemId: (itemId: string | null) => void;
  ready?: boolean;
};

function RootList({ ready = true, ...props }: ListProps) {
  useRootItemScrollRestoration({ ...props, ready });
  return null;
}

function mountRootList(initial: ListProps) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (props: ListProps) =>
    act(() => root.render(createElement(RootList, props)));
  render(initial);
  return {
    render,
    unmount: () => act(() => root.unmount()),
  };
}

function itemElement(itemId: string) {
  const element = document.createElement("div");
  element.dataset.itemId = itemId;
  return element;
}

const ITEMS = ["a", "b", "c"];

describe("root scroll restoration across mounts", () => {
  beforeEach(() => {
    mocks.getFeedItemElement.mockImplementation((itemId) =>
      itemId ? itemElement(itemId) : null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Drain any anchor a scenario left pending so scenarios stay isolated.
    const list = mountRootList({
      activeItemIds: [],
      selectedItemId: null,
      setSelectedItemId: () => {},
    });
    list.unmount();
    vi.clearAllMocks();
  });

  it("does not replay a stale anchor after an aborted restoration", () => {
    const setSelectedItemId = vi.fn();
    const first = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    first.unmount();
    vi.clearAllMocks();

    // Return from the reader with the anchor pending, but the anchored item
    // has not rendered yet, so restoration keeps retrying its scroll.
    captureRootScrollRestoration("a");
    mocks.getFeedItemElement.mockReturnValue(null);
    const second = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    // A hover moves the selection before the scroll lands: abort.
    second.render({
      activeItemIds: ITEMS,
      selectedItemId: "b",
      setSelectedItemId,
    });
    expect(mocks.scrollRootItemToTarget).not.toHaveBeenCalled();
    second.unmount();

    // An unrelated visit (sidebar to /views and back) with no capture.
    mocks.getFeedItemElement.mockImplementation((itemId) =>
      itemId ? itemElement(itemId) : null,
    );
    mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "b",
      setSelectedItemId,
    });

    expect(setSelectedItemId).not.toHaveBeenCalled();
    expect(mocks.scrollRootItemToTarget).toHaveBeenCalledTimes(1);
    const [target] = mocks.scrollRootItemToTarget.mock.calls[0] as [
      HTMLElement,
    ];
    expect(target.dataset.itemId).toBe("b");
  });

  it("keeps a capture fired after seeding for the next mount", () => {
    const setSelectedItemId = vi.fn();
    const first = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    expect(mocks.scrollRootItemToTarget).toHaveBeenCalledTimes(1);

    // Open "a" in the reader: the click captures, then a live pass runs
    // before the list unmounts. The capture must survive both.
    captureRootScrollRestoration("a");
    first.render({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    first.unmount();

    // "a" was archived while reading; the successor takes its place.
    mountRootList({
      activeItemIds: ["b", "c"],
      selectedItemId: "a",
      setSelectedItemId,
    });

    expect(setSelectedItemId).toHaveBeenCalledWith("b");
  });

  it("leaves the pending anchor untouched until the list is ready", () => {
    const setSelectedItemId = vi.fn();
    const first = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    captureRootScrollRestoration("a");
    first.unmount();
    vi.clearAllMocks();

    // The list remounts before its items have loaded; nothing may be
    // consumed or scrolled on those passes.
    const second = mountRootList({
      activeItemIds: [],
      selectedItemId: "a",
      setSelectedItemId,
      ready: false,
    });
    second.render({
      activeItemIds: [],
      selectedItemId: "a",
      setSelectedItemId,
      ready: false,
    });
    expect(setSelectedItemId).not.toHaveBeenCalled();
    expect(mocks.scrollRootItemToTarget).not.toHaveBeenCalled();

    // Items arrive without "a": the capture still drives the successor.
    second.render({
      activeItemIds: ["b", "c"],
      selectedItemId: "a",
      setSelectedItemId,
      ready: true,
    });
    expect(setSelectedItemId).toHaveBeenCalledWith("b");
  });

  it("restores to the current selection when nothing was captured", () => {
    const setSelectedItemId = vi.fn();
    const first = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    first.unmount();
    vi.clearAllMocks();

    mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "c",
      setSelectedItemId,
    });

    expect(setSelectedItemId).not.toHaveBeenCalled();
    const [target] = mocks.scrollRootItemToTarget.mock.calls[0] as [
      HTMLElement,
    ];
    expect(target.dataset.itemId).toBe("c");
  });
});

describe("root item link click capture", () => {
  it("captures only for a plain primary click that opens in place", () => {
    const setSelectedItemId = vi.fn();
    const list = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    const handleClick = createRootItemLinkClickHandler({
      canOpen: true,
      target: undefined,
      restorationId: "a",
    });

    handleClick({ preventDefault: () => {}, metaKey: true });
    handleClick({ preventDefault: () => {}, button: 1 });
    list.unmount();
    vi.clearAllMocks();

    // A remount after a modifier click behaves like a fresh visit.
    mountRootList({
      activeItemIds: ["b", "c"],
      selectedItemId: "c",
      setSelectedItemId,
    });
    expect(setSelectedItemId).not.toHaveBeenCalled();
  });

  it("captures the current selection for a plain click without an item", () => {
    const setSelectedItemId = vi.fn();
    const list = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    captureRootScrollRestorationOnClick({ preventDefault: () => {} });
    list.unmount();

    mountRootList({
      activeItemIds: ["b", "c"],
      selectedItemId: "a",
      setSelectedItemId,
    });
    expect(setSelectedItemId).toHaveBeenCalledWith("b");
  });

  it("captures for a plain click and blocks a link that cannot open", () => {
    const setSelectedItemId = vi.fn();
    const list = mountRootList({
      activeItemIds: ITEMS,
      selectedItemId: "a",
      setSelectedItemId,
    });
    const preventDefault = vi.fn();
    createRootItemLinkClickHandler({
      canOpen: false,
      target: undefined,
      restorationId: "a",
    })({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);

    createRootItemLinkClickHandler({
      canOpen: true,
      target: undefined,
      restorationId: "a",
    })({ preventDefault: () => {} });
    list.unmount();

    mountRootList({
      activeItemIds: ["b", "c"],
      selectedItemId: "a",
      setSelectedItemId,
    });
    expect(setSelectedItemId).toHaveBeenCalledWith("b");
  });
});

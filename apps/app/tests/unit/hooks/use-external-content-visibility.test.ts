// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { getDefaultStore } from "jotai";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionState } from "~/lib/data/atoms";
import { connectionStateAtom } from "~/lib/data/atoms";
import { flagAtoms } from "~/lib/hooks/useFlagState";
import { useExternalContentVisibility } from "~/lib/hooks/useExternalContentVisibility";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const store = getDefaultStore();
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

function Probe({ itemId }: { itemId: string }) {
  return createElement("output", null, useExternalContentVisibility(itemId));
}

function mount(itemId: string) {
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(createElement(Probe, { itemId })));
}

function rerender(itemId: string) {
  act(() => root!.render(createElement(Probe, { itemId })));
}

const visibility = () => container.querySelector("output")?.textContent;
const connection = (state: ConnectionState) =>
  act(() => store.set(connectionStateAtom, state));

beforeEach(() => {
  store.set(connectionStateAtom, "unknown");
  store.set(flagAtoms.ARTICLE_EXTERNAL_CONTENT, "show");
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

describe("External content visibility", () => {
  it("shows while the connection is unknown or connected, and follows Hide at once", () => {
    mount("item-1");
    expect(visibility()).toBe("show");
    connection("connected");
    expect(visibility()).toBe("show");
    act(() => store.set(flagAtoms.ARTICLE_EXTERNAL_CONTENT, "hide"));
    expect(visibility()).toBe("hide");
    act(() => store.set(flagAtoms.ARTICLE_EXTERNAL_CONTENT, "show"));
    expect(visibility()).toBe("show");
  });

  it("latches once the visit has been online, so going offline never hides a loaded frame", () => {
    store.set(connectionStateAtom, "connected");
    mount("item-1");
    expect(visibility()).toBe("show");
    connection("disconnected");
    expect(visibility()).toBe("show");
  });

  it("shows notices on a never-online visit until a connection arrives, then keeps showing", () => {
    store.set(connectionStateAtom, "disconnected");
    mount("item-1");
    expect(visibility()).toBe("hide");
    connection("connected");
    expect(visibility()).toBe("show");
    connection("disconnected");
    expect(visibility()).toBe("show");
  });

  it("resets the latch when the reader moves to another item", () => {
    store.set(connectionStateAtom, "connected");
    mount("item-1");
    connection("disconnected");
    expect(visibility()).toBe("show");
    rerender("item-2");
    expect(visibility()).toBe("hide");
    rerender("item-1");
    expect(visibility()).toBe("hide");
  });

  it("hides immediately even while latched online", () => {
    store.set(connectionStateAtom, "connected");
    mount("item-1");
    connection("disconnected");
    act(() => store.set(flagAtoms.ARTICLE_EXTERNAL_CONTENT, "hide"));
    expect(visibility()).toBe("hide");
  });
});

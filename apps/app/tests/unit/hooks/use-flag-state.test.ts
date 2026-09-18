// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createStore, Provider } from "jotai";
import { afterEach, expect, it } from "vitest";
import { useFlagState } from "~/lib/hooks/useFlagState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  localStorage.clear();
});

it("updates every flag reader, persists the value, and keeps provider stores isolated", () => {
  function Reader() {
    const [value, setValue] = useFlagState("INLINE_SHORTCUTS");
    return createElement(
      "button",
      { onClick: () => setValue("show-shortcuts") },
      value,
    );
  }
  function mount(store: ReturnType<typeof createStore>) {
    const container = document.createElement("div");
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Reader),
          createElement(Reader),
        ),
      ),
    );
    return container;
  }
  const first = mount(createStore());
  const second = mount(createStore());
  act(() => first.querySelector("button")!.click());
  expect(
    [...first.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual(["show-shortcuts", "show-shortcuts"]);
  expect(second.textContent).toBe("hide-shortcutshide-shortcuts");
  expect(localStorage.getItem("serial-flag-display-inline-shortcuts")).toBe(
    '"show-shortcuts"',
  );
  expect(mount(createStore()).textContent).toBe("show-shortcutsshow-shortcuts");
});

it("switches a mounted reader between flags without retaining the previous flag value", () => {
  localStorage.setItem("serial-article-footnotes", '"hide"');
  localStorage.setItem("serial-article-table-of-contents", '"show"');
  function Reader({
    flag,
  }: {
    flag: "ARTICLE_FOOTNOTES" | "ARTICLE_TABLE_OF_CONTENTS";
  }) {
    return useFlagState(flag)[0];
  }
  const store = createStore();
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(
        Provider,
        { store },
        createElement(Reader, { flag: "ARTICLE_FOOTNOTES" }),
      ),
    ),
  );
  expect(container.textContent).toBe("hide");
  act(() =>
    root.render(
      createElement(
        Provider,
        { store },
        createElement(Reader, { flag: "ARTICLE_TABLE_OF_CONTENTS" }),
      ),
    ),
  );
  expect(container.textContent).toBe("show");
});

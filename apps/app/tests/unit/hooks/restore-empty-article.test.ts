// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRestoreArticleProgress } from "~/lib/hooks/useRestoreArticleProgress";

vi.mock("~/lib/scroll", () => ({ getScrollContainer: () => document.body }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
});

function Restore(props: Parameters<typeof useRestoreArticleProgress>[0]) {
  useRestoreArticleProgress(props);
  return null;
}

it.each([0, 12])(
  "reveals an empty article shell after loading with saved progress %i",
  (progress) => {
    const article = document.createElement("article");
    article.innerHTML =
      "<h1 data-serial-header>Article title</h1><h6 data-serial-header>Author</h6><div></div>";
    document.body.scrollTo = vi.fn();
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    const props = { contentId: "empty", articleElement: article, progress };
    act(() => root.render(createElement(Restore, { ...props, ready: false })));
    expect(article.style.visibility).toBe("hidden");
    act(() => root.render(createElement(Restore, { ...props, ready: true })));
    expect(article.style.visibility).toBe("");
    expect(document.body.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "instant",
    });
  },
);

it("keeps a pending reader body hidden until its content placeholder is removed", async () => {
  const article = document.createElement("article");
  article.innerHTML =
    "<h1 data-serial-header>Article title</h1><div data-reader-content-pending></div>";
  document.body.scrollTo = vi.fn();
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() =>
    root.render(
      createElement(Restore, {
        contentId: "pending",
        articleElement: article,
        progress: 0,
        ready: true,
      }),
    ),
  );
  expect(article.style.visibility).toBe("hidden");
  await act(async () => {
    article.querySelector("[data-reader-content-pending]")!.remove();
    await Promise.resolve();
  });
  expect(article.style.visibility).toBe("");
});

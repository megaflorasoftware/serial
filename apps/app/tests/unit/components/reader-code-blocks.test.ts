// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleContent } from "~/components/feed/read/ArticleContent";
import { BookmarkArticleContent } from "~/components/bookmarks/BookmarkArticleContent";
import * as highlighter from "~/components/content-reader/highlightCode";

vi.mock("~/components/content-reader/highlightCodeClient", () => ({
  requestCodeHighlight: (
    code: string,
    language: string | undefined,
    onResult: (html: string | null) => void,
  ) => {
    onResult(highlighter.highlightCode(code, language));
    return () => {};
  },
}));

vi.mock("~/lib/hooks/useFlagState", () => ({ useFlagState: () => ["iframe"] }));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
});

async function render(content: string, kind = "full") {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  const element =
    kind === "bookmark"
      ? createElement(BookmarkArticleContent, { content })
      : createElement(ArticleContent, {
          content,
          simplified: kind === "simplified",
        });
  await act(async () => {
    root.render(element);
  });
  return { container, root, element };
}

describe("article code blocks", () => {
  it.each(["full", "simplified", "bookmark"])(
    "excludes surrounding controls and formatting from %s code",
    async (kind) => {
      const { container } = await render(
        '<pre class="language-js">\n<code>  const value = 42;\n</code>\n<button>Copy</button></pre>',
        kind,
      );
      expect(container.querySelector("pre")?.textContent).toBe(
        "  const value = 42;\n",
      );
      expect(container.querySelector("button")).toBeNull();
    },
  );

  it("preserves code direction and an explicit accessible label", async () => {
    const { container } = await render(
      '<div dir="rtl"><pre dir="ltr" aria-label="Example">const value = 42;</pre></div>',
    );
    expect(container.querySelector("pre")?.dir).toBe("ltr");
    expect(container.querySelector("pre")?.getAttribute("aria-label")).toBe(
      "Example",
    );
  });
  it.each(["full", "simplified", "bookmark"])(
    "highlights %s code without changing text or inline code",
    async (kind) => {
      const { container } = await render(
        '<p>Use <code>value</code>.</p><pre id="sample"><code class="language-js">const value = &quot;&lt;img src=x onerror=alert(1)&gt;&amp;&quot;;\n  console.log(value);</code></pre>',
        kind,
      );
      expect(container.querySelector("pre")?.textContent).toBe(
        'const value = "<img src=x onerror=alert(1)>&";\n  console.log(value);',
      );
      expect(container.querySelector("pre .hljs-keyword")).not.toBeNull();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("p code")?.innerHTML).toBe("value");
      expect(container.querySelector("pre")?.tabIndex).toBe(0);
    },
  );

  it("reads language aliases from pre and strips existing token markup", async () => {
    const { container } = await render(
      '<pre class="language-py"><code><span>def</span> greet(name):<br>  return &quot;Hello &quot; + name</code></pre>',
    );
    expect(container.querySelector("pre")?.textContent).toBe(
      'def greet(name):\n  return "Hello " + name',
    );
    expect(container.querySelector(".hljs-keyword")?.textContent).toBe("def");
  });

  it.each(["language-unknown", "nohighlight", "language-text"])(
    "keeps %s blocks as plain text",
    async (className) => {
      const { container } = await render(
        `<pre class="${className}"><code>const value = 42;</code></pre>`,
      );
      expect(container.querySelector("pre")?.textContent).toBe(
        "const value = 42;",
      );
      expect(container.querySelector("pre span")).toBeNull();
    },
  );

  it("does not tokenize again on unrelated rerenders and discards stale highlighted content", async () => {
    const spy = vi.spyOn(highlighter, "highlightCode");
    const { container, root, element } = await render(
      '<pre class="language-js">const first = 42;</pre>',
    );
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render({ ...element });
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        createElement(ArticleContent, {
          content: '<pre class="language-text">second</pre>',
        }),
      );
    });
    expect(container.querySelector("pre")?.innerHTML).toBe(
      "<code>second</code>",
    );
  });
});

// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookmarkArticleContent } from "~/components/bookmarks/BookmarkArticleContent";
import { SANDBOXED_SRC_FRAME_SANDBOX } from "~/components/content-reader/SandboxedFrame";

vi.mock("~/lib/hooks/useFlagState", () => ({
  useFlagState: () => ["youtube", () => undefined],
}));
vi.mock("~/components/CustomVideoPlayer", () => ({
  CustomVideoPlayer: () => null,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Array<ReturnType<typeof createRoot>> = [];

function render(content: string, externalContent: "show" | "hide" = "show") {
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(BookmarkArticleContent, {
        content,
        externalContent,
        noticeHref: "https://example.com/article",
        originActionLabel: "Open in Website",
      }),
    );
  });
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
});

const VERSION_1_PLACEHOLDER =
  '<p>Body</p><div data-serial-embed="youtube" data-video-id="dQw4w9WgXcQ" data-start="42"></div>';
const VERSION_2_CAPTURE =
  '<p>Body</p><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42" height="315"></iframe>' +
  '<iframe src="https://open.spotify.com/embed/track/1" height="152"></iframe>';

describe("Bookmark article content", () => {
  it("renders the Page capture at once", () => {
    const container = render("<p>Captured article body</p>");
    expect(container.textContent).toBe("Captured article body");
    expect(container.querySelector("[data-reader-content-pending]")).toBeNull();
  });

  it("renders a version 2 capture's frames through the shared External content path", () => {
    const container = render(VERSION_2_CAPTURE);
    const video = container.querySelector("[data-article-video-embed] iframe")!;
    expect(video.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      "[data-reader-frame='src'] iframe",
    )!;
    expect(frame.getAttribute("src")).toBe(
      "https://open.spotify.com/embed/track/1",
    );
    expect(frame.getAttribute("sandbox")).toBe(SANDBOXED_SRC_FRAME_SANDBOX);
    expect(frame.style.height).toBe("152px");
  });

  it("still renders a version 1 YouTube placeholder as the video", () => {
    const container = render(VERSION_1_PLACEHOLDER);
    const video = container.querySelector("[data-article-video-embed] iframe")!;
    expect(video.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
    );
    expect(container.querySelector("[data-serial-embed]")).toBeNull();
  });

  it("drops a malformed version 1 placeholder", () => {
    const container = render(
      '<p>Body</p><div data-serial-embed="youtube" data-video-id="../evil"></div>',
    );
    expect(container.textContent).toBe("Body");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("swaps every frame for the External content notice when hidden", () => {
    for (const content of [VERSION_1_PLACEHOLDER, VERSION_2_CAPTURE]) {
      const container = render(content, "hide");
      expect(container.querySelector("iframe")).toBeNull();
      const notices = container.querySelectorAll(
        "[data-reader-notice='youtube']",
      );
      expect(notices.length).toBeGreaterThan(0);
      expect(notices[0]?.querySelector("a")?.getAttribute("href")).toBe(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42",
      );
    }
  });
});

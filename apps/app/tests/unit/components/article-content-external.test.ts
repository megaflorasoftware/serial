// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOXED_SRC_FRAME_SANDBOX } from "~/components/content-reader/SandboxedFrame";
import { ArticleContent } from "~/components/feed/read/ArticleContent";

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
      createElement(ArticleContent, {
        content,
        externalContent,
        noticeHref: "https://example.com/post",
        originActionLabel: "Open in Website",
      }),
    );
  });
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe("HTML body External content", () => {
  it("routes a stored YouTube frame to the video embed", () => {
    const container = render(
      '<p>Intro</p><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42" height="315"></iframe>',
    );
    const video = container.querySelector("[data-article-video-embed] iframe")!;
    expect(video.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42",
    );
    expect(container.querySelector("[data-reader-frame]")).toBeNull();
  });

  it("sandboxes any other https frame and keeps its stored height", () => {
    const container = render(
      '<iframe src="https://open.spotify.com/embed/track/1" height="152"></iframe>',
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      "[data-reader-frame='src'] iframe",
    )!;
    expect(frame.getAttribute("src")).toBe(
      "https://open.spotify.com/embed/track/1",
    );
    expect(frame.getAttribute("sandbox")).toBe(SANDBOXED_SRC_FRAME_SANDBOX);
    expect(frame.getAttribute("referrerpolicy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(frame.style.height).toBe("152px");
  });

  it("falls back to the default height when the stored height is out of range", () => {
    const container = render(
      '<iframe src="https://open.spotify.com/embed/track/1" height="9000"></iframe>',
    );
    expect(container.querySelector("iframe")?.style.height).toBe("480px");
  });

  it("never renders a legacy raw frame unsandboxed", () => {
    const container = render(
      '<iframe src="https://legacy.example/embed" width="600" allow="autoplay" allowfullscreen></iframe>' +
        '<iframe src="http://insecure.example/embed"></iframe>' +
        "<iframe></iframe>",
    );
    const frames = container.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.getAttribute("sandbox")).toBe(SANDBOXED_SRC_FRAME_SANDBOX);
    expect(frames[0]?.hasAttribute("allow")).toBe(true);
    expect(frames[0]?.getAttribute("allow")).not.toContain("autoplay");
    expect(
      container.querySelectorAll("[data-reader-notice='externalContent']"),
    ).toHaveLength(2);
  });

  it("swaps every frame for the notice when External content is hidden", () => {
    const container = render(
      '<p>Intro</p><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>' +
        '<iframe src="https://open.spotify.com/embed/track/1"></iframe>',
      "hide",
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("[data-article-video-embed]")).toBeNull();
    const notices = container.querySelectorAll(
      "[data-reader-notice='externalContent']",
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.textContent).toContain(
      "This interactive content is available on the original site",
    );
    expect(notices[0]?.querySelector(".sr-only")).toBeNull();
    expect(notices[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/post",
    );
    expect(container.textContent).toContain("Intro");
  });
});

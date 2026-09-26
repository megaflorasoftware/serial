import { describe, expect, it } from "vitest";
import {
  BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES,
  SANITIZER_POLICY_VERSION,
} from "@serial/bookmark-capture";
import { extractStaticCapture } from "~/server/bookmarks/extract";

/**
 * The server sanitizes through the shared `bookmark-capture` sanitizer inside
 * a JSDOM window. These tests drive it through the static capture path, the
 * server's only entry to it.
 */
function sanitize(
  contentHtml: string,
  effectiveUrl = "https://example.com/articles/post",
) {
  const result = extractStaticCapture({
    sourceUrl: effectiveUrl,
    effectiveUrl,
    html: `<!doctype html><html><head><title>Title</title></head><body><main><article>${contentHtml}</article></main></body></html>`,
  });
  return result.observation.capture
    ? { capture: result.observation.capture, reason: undefined }
    : { capture: null, reason: result.captureFailureReason };
}

const readable = (inner: string) =>
  `<h1>Title</h1><p>${"A sufficiently long paragraph so Readability keeps the article body. ".repeat(6)}</p>${inner}`;

describe("Page capture sanitization", () => {
  it("keeps reader HTML while stripping active and identifying markup", () => {
    const { capture } = sanitize(
      readable(`
        <section class="tracking" onclick="steal()" data-secret="value">
          <style>body { display: none }</style><script>steal()</script>
          <form><input value="private"></form>
          <p><a href="/next">Next</a><img src="../image.jpg" referrerpolicy="unsafe-url"></p>
        </section>`),
    );
    expect(capture).not.toBeNull();
    expect(capture!.contentHtml).toContain('href="https://example.com/next"');
    expect(capture!.contentHtml).toContain(
      'src="https://example.com/image.jpg"',
    );
    expect(capture!.contentHtml).not.toMatch(
      /script|style|form|input|onclick|class|secret|referrerpolicy/,
    );
    expect(capture!.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(capture!.sanitizerPolicyVersion).toBe(SANITIZER_POLICY_VERSION);
    expect(capture!.sanitizerPolicyVersion).toBe(2);
  });

  it("rejects dangerous URLs and an entirely invalid srcset", () => {
    const { capture } = sanitize(
      readable(`
        <p><a href="javascript:alert(1)">Bad</a></p>
        <img src="data:image/png;base64,AA" srcset="/ok.png 1x, javascript:bad 2x">`),
    );
    expect(capture!.contentHtml).not.toContain("javascript:");
    expect(capture!.contentHtml).not.toContain("data:image");
    expect(capture!.contentHtml).not.toContain("srcset");
  });

  it("rewrites ids and matching fragment links deterministically", () => {
    const { capture } = sanitize(
      readable('<p id="note:1">Note</p><p><a href="#note:1">Back</a></p>'),
    );
    expect(capture!.contentHtml).toMatch(/id="capture-[a-f0-9]{8}-note-1"/);
    expect(capture!.contentHtml).toMatch(/href="#capture-[a-f0-9]{8}-note-1"/);
  });

  it("retains https frames as source and height only, and drops every other frame", () => {
    const { capture } = sanitize(
      readable(`
        <iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42" height="315" width="560" allow="autoplay" sandbox="" allowfullscreen></iframe>
        <iframe src="https://player.vimeo.com/video/1" height="abc" loading="lazy"></iframe>
        <iframe src="http://insecure.example/embed"></iframe>
        <iframe src="javascript:alert(1)"></iframe>
        <iframe srcdoc="<script>x()</script>"></iframe>
        <iframe src="https://user:pass@tracker.example/embed"></iframe>`),
    );
    const html = capture!.contentHtml;
    expect(html).toContain(
      '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42" height="315"></iframe>',
    );
    // Readability keeps only video-host frames before the sanitizer runs; a
    // non-numeric height is dropped.
    expect(html).toContain(
      '<iframe src="https://player.vimeo.com/video/1"></iframe>',
    );
    expect(html.match(/<iframe/g)).toHaveLength(2);
    expect(html).not.toMatch(
      /insecure|javascript|srcdoc|tracker|allow|sandbox|width/,
    );
    expect(html).not.toContain("data-serial-embed");
  });

  it("still lets a version 1 placeholder through the allowlist", () => {
    expect(BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES).toEqual(
      expect.arrayContaining([
        "data-serial-embed",
        "data-video-id",
        "data-start",
      ]),
    );
  });

  it("reports stored HTML beyond its limit as an invalid capture", () => {
    expect(
      sanitize(readable(`<p>${"x".repeat(2 * 1024 * 1024)}</p>`)).reason,
    ).toBe("invalid_capture");
  });
});

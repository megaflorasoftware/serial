import { useMemo } from "react";
import type { ReaderAspectRatio } from "@serial/standard-site";

/**
 * The one sandboxed frame the reader ever shows, with one locked-down policy
 * per frame source. Authored HTML blocks render here from `srcdoc`; every
 * `src` frame from RSS bodies, platform blocks and Bookmark captures renders
 * here too, so widening a policy is a deliberate change to this file alone.
 *
 * Whether a frame is shown at all is decided upstream: the External content
 * preference and the offline latch swap this component for the notice, and a
 * source that is not `https` never reaches it.
 *
 * The user reviews every change to this file by hand before merge.
 */

/** Authored HTML: no scripts, same-origin, forms or navigation. Popups only, so links leave in a new tab. */
export const SANDBOXED_FRAME_SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox";

/**
 * A `src` frame: scripts run at an opaque origin so embed providers work, with
 * no same-origin, forms, top navigation, pointer lock or presentation grants.
 */
export const SANDBOXED_SRC_FRAME_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** Fetches allowed from inside an authored document: images, fonts and stylesheets only. */
export const SANDBOXED_FRAME_CSP =
  "default-src 'none'; img-src https: data:; font-src https: data:; style-src https: 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export const SANDBOXED_FRAME_PERMISSIONS =
  "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'";

/** The lexicon range for an authored height; anything else is rejected upstream. */
export const SANDBOXED_FRAME_DEFAULT_HEIGHT = 480;

/**
 * Wraps authored markup in a document that carries the policy itself, since
 * `srcdoc` documents inherit no headers and the `csp` attribute is Chromium
 * only. `<base target>` sends every link to a new tab, which is `noopener`
 * by default in current browsers.
 */
export function sandboxedFrameDocument(html: string) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOXED_FRAME_CSP}">` +
    '<base target="_blank">' +
    "</head><body>" +
    html +
    "</body></html>"
  );
}

/** A frame's source: authored markup rendered through `srcdoc`, or an `https` page. */
export type SandboxedFrameSource =
  { kind: "html"; html: string } | { kind: "src"; src: string };

export type SandboxedFrameProps = {
  source: SandboxedFrameSource;
  title: string;
  height: number | null;
  aspectRatio: ReaderAspectRatio | null;
};

function frameStyle(
  height: number | null,
  aspectRatio: ReaderAspectRatio | null,
) {
  if (height !== null) return { height };
  if (aspectRatio)
    return { aspectRatio: `${aspectRatio.width} / ${aspectRatio.height}` };
  return { height: SANDBOXED_FRAME_DEFAULT_HEIGHT };
}

export function SandboxedFrame({
  source,
  title,
  height,
  aspectRatio,
}: SandboxedFrameProps) {
  const html = source.kind === "html" ? source.html : null;
  const srcDoc = useMemo(
    () => (html === null ? undefined : sandboxedFrameDocument(html)),
    [html],
  );
  const style = frameStyle(height, aspectRatio);
  return (
    <div data-reader-frame={source.kind} data-article-block="">
      {source.kind === "html" ? (
        <iframe
          srcDoc={srcDoc}
          title={title}
          sandbox={SANDBOXED_FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          allow={SANDBOXED_FRAME_PERMISSIONS}
          // Chromium honors this attribute; other engines rely on the meta tag inside.
          {...{ csp: SANDBOXED_FRAME_CSP }}
          style={style}
        />
      ) : (
        <iframe
          src={source.src}
          title={title}
          sandbox={SANDBOXED_SRC_FRAME_SANDBOX}
          referrerPolicy="strict-origin-when-cross-origin"
          loading="lazy"
          allow={SANDBOXED_FRAME_PERMISSIONS}
          style={style}
        />
      )}
    </div>
  );
}

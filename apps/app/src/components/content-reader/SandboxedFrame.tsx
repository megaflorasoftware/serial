import { useMemo } from "react";
import { useAtomValue } from "jotai";
import type { ReaderAspectRatio } from "@serial/standard-site";
import { ReaderNotice } from "~/components/content-reader/ReaderNotice";
import { isDisconnectedAtom } from "~/lib/data/atoms";

/**
 * The one sandboxed frame the reader ever shows, with one locked-down policy.
 * Authored HTML blocks render here from `srcdoc`; every `src` frame the reader
 * later admits goes through this same component, so widening the policy is a
 * deliberate change to this file alone.
 *
 * The user reviews every change to this file by hand before merge.
 */

/** No scripts, same-origin, forms or navigation. Popups only, so links leave in a new tab. */
export const SANDBOXED_FRAME_SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox";

/** Fetches allowed from inside the frame: images, fonts and stylesheets only. */
export const SANDBOXED_FRAME_CSP =
  "default-src 'none'; img-src https: data:; font-src https: data:; style-src https: 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

export type SandboxedFrameProps = {
  /** Authored markup, rendered through `srcdoc`. */
  html: string;
  title: string;
  height: number | null;
  aspectRatio: ReaderAspectRatio | null;
  /** Simplified mode shows the notice instead of loading the frame; so does being offline. */
  simplified: boolean;
  noticeHref: string;
  originActionLabel: string;
};

export function SandboxedFrame({
  html,
  title,
  height,
  aspectRatio,
  simplified,
  noticeHref,
  originActionLabel,
}: SandboxedFrameProps) {
  const offline = useAtomValue(isDisconnectedAtom);
  const srcDoc = useMemo(() => sandboxedFrameDocument(html), [html]);
  if (simplified || offline) {
    return (
      <ReaderNotice
        kind="frame"
        href={noticeHref}
        originActionLabel={originActionLabel}
      />
    );
  }
  const style =
    height !== null
      ? { height }
      : aspectRatio
        ? { aspectRatio: `${aspectRatio.width} / ${aspectRatio.height}` }
        : { height: SANDBOXED_FRAME_DEFAULT_HEIGHT };
  return (
    <div data-reader-frame data-article-block="">
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
    </div>
  );
}

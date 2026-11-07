import createDOMPurify from "dompurify";

import {
  BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES,
  BOOKMARK_CAPTURE_ALLOWED_TAGS,
  BOOKMARK_CAPTURE_LIMITS,
} from "./policy";

const URL_ATTRIBUTES = ["href", "src"] as const;

function allowedResolvedUrl(value: string, baseUrl: string, isLink: boolean) {
  if (value.startsWith("#")) return isLink ? value : null;
  try {
    const resolved = new URL(value, baseUrl);
    if (resolved.username || resolved.password) return null;
    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      return resolved.toString();
    }
    if (isLink && resolved.protocol === "mailto:") return resolved.toString();
    return null;
  } catch {
    return null;
  }
}

function rewriteSrcset(value: string, baseUrl: string) {
  const candidates = value.split(",").map((candidate) => candidate.trim());
  if (candidates.length === 0 || candidates.some((candidate) => !candidate)) {
    return null;
  }
  const rewritten: string[] = [];
  for (const candidate of candidates) {
    const [url, ...descriptor] = candidate.split(/\s+/);
    const resolved = url ? allowedResolvedUrl(url, baseUrl, false) : null;
    if (!resolved || descriptor.length > 1) return null;
    if (
      descriptor[0] &&
      !/^([1-9]\d*(?:\.\d+)?x|[1-9]\d*w)$/.test(descriptor[0])
    ) {
      return null;
    }
    rewritten.push([resolved, ...descriptor].join(" "));
  }
  return rewritten.join(", ");
}

/**
 * A frame the reader may show as External content: the source, absolute and
 * `https`, plus an integer height. Every other attribute is dropped, and a
 * frame without an eligible source is removed. The reader decides at render
 * time whether the source is shown; storage never carries a frame policy.
 */
function storedFrame(document: Document, iframe: HTMLIFrameElement) {
  const source = iframe.getAttribute("src");
  if (!source) return null;
  let resolved: URL;
  try {
    resolved = new URL(source, document.baseURI);
  } catch {
    return null;
  }
  if (resolved.protocol !== "https:" || resolved.username || resolved.password)
    return null;
  const height = iframe.getAttribute("height");
  const frame = document.createElement("iframe");
  frame.setAttribute("src", resolved.toString());
  if (height && /^\d+$/.test(height)) frame.setAttribute("height", height);
  return frame;
}

function captureIdPrefix(effectiveUrl: string) {
  let hash = 2166136261;
  for (const character of effectiveUrl) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `capture-${(hash >>> 0).toString(16)}-`;
}

function rewriteDocument(document: Document, effectiveUrl: string) {
  for (const iframe of document.querySelectorAll("iframe")) {
    const frame = storedFrame(document, iframe);
    if (frame) iframe.replaceWith(frame);
    else iframe.remove();
  }

  const idPrefix = captureIdPrefix(effectiveUrl);
  const rewrittenIds = new Map<string, string>();
  for (const element of document.querySelectorAll("[id]")) {
    const id = element.getAttribute("id");
    if (!id) continue;
    const rewritten = `${idPrefix}${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    rewrittenIds.set(id, rewritten);
    element.setAttribute("id", rewritten);
  }

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of URL_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === "href" && value.startsWith("#")) {
        const target = rewrittenIds.get(value.slice(1));
        if (target) element.setAttribute(attribute, `#${target}`);
        else element.removeAttribute(attribute);
        continue;
      }
      const resolved = allowedResolvedUrl(
        value,
        effectiveUrl,
        attribute === "href",
      );
      if (resolved) element.setAttribute(attribute, resolved);
      else element.removeAttribute(attribute);
    }
    const srcset = element.getAttribute("srcset");
    if (srcset !== null) {
      const rewritten = rewriteSrcset(srcset, effectiveUrl);
      if (rewritten) element.setAttribute("srcset", rewritten);
      else element.removeAttribute("srcset");
    }
  }
}

export function sanitizeCaptureHtml(
  contentHtml: string,
  effectiveUrl: string,
  sourceDocument: Document,
) {
  const captureDocument =
    new sourceDocument.defaultView!.DOMParser().parseFromString(
      contentHtml,
      "text/html",
    );
  if (
    captureDocument.querySelectorAll("*").length >
    BOOKMARK_CAPTURE_LIMITS.domElements
  ) {
    return { reason: "invalid_capture" as const };
  }
  const base = captureDocument.createElement("base");
  base.href = effectiveUrl;
  captureDocument.head.append(base);
  rewriteDocument(captureDocument, effectiveUrl);
  const purifier = createDOMPurify(sourceDocument.defaultView!);
  const sanitized = purifier
    .sanitize(captureDocument.body.innerHTML, {
      ALLOWED_TAGS: [...BOOKMARK_CAPTURE_ALLOWED_TAGS],
      ALLOWED_ATTR: [...BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: null,
        attributeNameCheck: null,
        allowCustomizedBuiltInElements: false,
      },
    })
    .trim();
  if (!sanitized) return { reason: "invalid_capture" as const };
  if (
    new TextEncoder().encode(sanitized).byteLength >
    BOOKMARK_CAPTURE_LIMITS.storedHtmlBytes
  ) {
    return { reason: "too_large" as const };
  }
  return { contentHtml: sanitized };
}

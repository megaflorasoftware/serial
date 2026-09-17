import { BOOKMARK_CAPTURE_LIMITS } from "./policy";

function codePointLength(value: string) {
  return [...value].length;
}

export function boundedText(
  value: string | null | undefined,
  maximum: number,
) {
  const normalized = value?.trim();
  if (!normalized || codePointLength(normalized) > maximum) return undefined;
  return normalized;
}

export function resolvedHttpUrl(
  value: string | null | undefined,
  baseUrl: string,
) {
  if (!value) return undefined;
  try {
    const url = new URL(value, baseUrl);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      new TextEncoder().encode(url.toString()).byteLength >
        BOOKMARK_CAPTURE_LIMITS.urlBytes
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function metaContent(document: Document, selector: string) {
  return document.querySelector<HTMLMetaElement>(selector)?.content ?? null;
}

/** The article's declared Open Graph image, resolved against the final page URL. */
export function openGraphImageUrl(document: Document, effectiveUrl: string) {
  for (const property of ["og:image:secure_url", "og:image"]) {
    for (const meta of document.querySelectorAll<HTMLMetaElement>(`meta[property="${property}"]`)) {
      const url = resolvedHttpUrl(meta.content, effectiveUrl);
      if (url) return url;
    }
  }
  return undefined;
}

import { convertReaderBody, parseAtUri } from "@serial/standard-site";
import type { ReaderBody } from "@serial/standard-site";
import { detectTruncatedContent } from "~/lib/utils/detectTruncatedContent";

/**
 * A body is loaded when it carries something the reader can render. `null`
 * means "not loaded yet"; an empty HTML body means the item has no content.
 */
export function hasReaderBodyContent(body: ReaderBody | null | undefined) {
  return (
    body !== null &&
    body !== undefined &&
    (body.form !== "html" || body.html.trim().length > 0)
  );
}

/**
 * Bridge until typed React rendering replaces the HTML reader: an HTML body
 * is already HTML, a Document source derives to HTML in the browser.
 */
export function readerBodyHtml(body: ReaderBody | null | undefined) {
  if (!body) return "";
  if (body.form === "html") return body.html;
  const did = parseAtUri(body.source.uri)?.did;
  if (!did) return "";
  return convertReaderBody(body, did)?.html ?? "";
}

/**
 * Only a loaded HTML body can be partial. An unloaded body says nothing yet,
 * and a Document source is always the whole document.
 */
export function isTruncatedReaderBody(
  body: ReaderBody | null | undefined,
  contentSnippet: string,
) {
  return (
    body?.form === "html" && detectTruncatedContent(body.html, contentSnippet)
  );
}

/**
 * A body belongs to the content revision named by `contentHash`. The server
 * naming a revision the client has not seen (a different hash, or a first
 * hash for a row loaded before hashing) proves the body is stale. Two unknown
 * hashes prove nothing, so the loaded body is kept.
 */
export function hasContentRevisionChanged(
  previous: { contentHash: string | null } | undefined,
  next: { contentHash: string | null },
) {
  return !!next.contentHash && previous?.contentHash !== next.contentHash;
}

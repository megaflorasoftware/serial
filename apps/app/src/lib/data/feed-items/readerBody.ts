import { convertReaderBody, parseAtUri } from "@serial/standard-site";
import type { ReaderBody } from "@serial/standard-site";

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

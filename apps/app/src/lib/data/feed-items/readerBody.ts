import { deriveReaderDocument, parseAtUri } from "@serial/standard-site";
import type { ReaderBody, ReaderDocument } from "@serial/standard-site";
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
 * What the reader draws for a body: HTML as it stands, or the Reader document
 * derived from a Document source and its Reference snapshots. Null when the
 * body is not loaded or the source does not derive.
 */
export type ReaderContent =
  | { form: "html"; html: string }
  | { form: "document"; document: ReaderDocument };

export function readerContent(
  body: ReaderBody | null | undefined,
): ReaderContent | null {
  if (!body) return null;
  if (body.form === "html") return { form: "html", html: body.html };
  const did = parseAtUri(body.source.uri)?.did;
  if (!did) return null;
  const document = deriveReaderDocument(body, did);
  return document ? { form: "document", document } : null;
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

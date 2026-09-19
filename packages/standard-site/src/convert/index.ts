import { z } from "zod";
import { convertLeafletContent, leafletContentSchema } from "./leaflet";
import { convertOffprintContent, offprintContentSchema } from "./offprint";
import { convertPcktItems, pcktBlobSchema, pcktContentSchema } from "./pckt";
import type { ConvertedDocument } from "./shared";
import {
  BLOCK_NATIVE_CONTENT_TYPES,
  isBlockNativeContentType,
  type DocumentRecord,
} from "../lexicons";
import { parseLosslessJson } from "../lossless-json";
import { sanitizeArticleHtml } from "../sanitize";
import { documentPublicationUri } from "../record-preview";
import type { RecordLookup } from "../record-preview";
import { parseDocumentRecord } from "../lexicons";
import { base64ToBytes } from "../reader-body";
import type { DocumentSource, SourceReaderBody } from "../reader-body";

export type { ConvertedDocument } from "./shared";
export { INTERACTIVE_PLACEHOLDER_TEXT, parseYouTubeReference } from "./html";

/**
 * Loads a blob's bytes from the owning repo. The package never fetches; the app
 * supplies this over `com.atproto.sync.getBlob` through its hardened fetch.
 */
export type BlobLoader = (did: string, cid: string) => Promise<Uint8Array>;

export type ConvertDocumentOptions = {
  /** DID of the repo the document lives in; every blob reference resolves against it. */
  did: string;
  loadBlob: BlobLoader;
  /** Records already resolved for this document, keyed by URI. */
  records?: RecordLookup;
};

const leafletBlobPagesSchema = z.array(z.unknown());

const leafletOverflowSchema = z.object({
  blobPages: z.object({ ref: z.object({ $link: z.string() }) }).optional(),
});

function decodeJsonBlob(bytes: Uint8Array): unknown {
  return parseLosslessJson(new TextDecoder().decode(bytes));
}

/** The one overflow blob a block-native content object may point at. */
export function overflowBlobCid(content: unknown): string | null {
  const typed = z.looseObject({ $type: z.string() }).safeParse(content);
  if (!typed.success) return null;
  switch (typed.data.$type) {
    case BLOCK_NATIVE_CONTENT_TYPES.leaflet: {
      const overflow = leafletOverflowSchema.safeParse(typed.data);
      return overflow.success
        ? (overflow.data.blobPages?.ref.$link ?? null)
        : null;
    }
    case BLOCK_NATIVE_CONTENT_TYPES.pckt: {
      const parsed = pcktContentSchema.safeParse(typed.data);
      if (!parsed.success || parsed.data.items?.length) return null;
      return parsed.data.blob?.ref.$link ?? null;
    }
    default:
      return null;
  }
}

/**
 * Pulls overflowed content back inline. Leaflet consumers must ignore `pages`
 * when `blobPages` is set; pckt uses `blob` only when `items` is absent or empty.
 */
function inlineOverflow(content: unknown, bytes: Uint8Array | null): unknown {
  const cid = overflowBlobCid(content);
  if (cid === null) return content;
  if (!bytes) return null;
  const typed = content as { $type: string };
  const decoded = decodeJsonBlob(bytes);
  if (typed.$type === BLOCK_NATIVE_CONTENT_TYPES.leaflet) {
    const pages = leafletBlobPagesSchema.safeParse(decoded);
    return pages.success
      ? { $type: BLOCK_NATIVE_CONTENT_TYPES.leaflet, pages: pages.data }
      : null;
  }
  const items = pcktBlobSchema.safeParse(decoded);
  return items.success
    ? { $type: BLOCK_NATIVE_CONTENT_TYPES.pckt, items: items.data }
    : null;
}

/**
 * Converts content with no blob overflow left. The converters emit HTML that is a
 * fixed point of `sanitizeArticleHtml` by construction; this is exported so tests
 * can assert that on the raw output.
 */
export function convertResolvedContent(
  content: unknown,
  did: string,
  records?: RecordLookup,
): ConvertedDocument | null {
  const leaflet = leafletContentSchema.safeParse(content);
  if (leaflet.success) return convertLeafletContent(leaflet.data, did, records);
  const offprint = offprintContentSchema.safeParse(content);
  if (offprint.success)
    return convertOffprintContent(offprint.data, did, records);
  const pckt = pcktContentSchema.safeParse(content);
  if (pckt.success && pckt.data.items) {
    return convertPcktItems(pckt.data.items, did, records);
  }
  return null;
}

export const MAX_EMBEDDED_RECORDS_PER_DOCUMENT = 16;

/**
 * The records a document's body reads while rendering, in encounter order and
 * capped: cards, mentions and galleries. Documents referenced by cards also
 * need their publications, which the caller resolves after these.
 */
export function discoverReferences(content: unknown, did: string) {
  const references = new Set<string>();
  convertResolvedContent(content, did, (uri) => {
    if (references.size < MAX_EMBEDDED_RECORDS_PER_DOCUMENT)
      references.add(uri);
    return undefined;
  });
  return [...references];
}

/** Publications of referenced documents, so cards can name and link their site. */
export function referencedPublications(
  references: readonly string[],
  records: RecordLookup,
) {
  const publications = new Set<string>();
  for (const uri of references) {
    const document = parseDocumentRecord(records(uri));
    const site = document ? documentPublicationUri(document.value) : null;
    if (site && !references.includes(site)) publications.add(site);
  }
  return [...publications];
}

function finish(converted: ConvertedDocument | null) {
  if (!converted || !converted.html.trim()) return null;
  return { ...converted, html: sanitizeArticleHtml(converted.html) };
}

/**
 * Converts a block-native document body to article HTML. Returns null when the
 * document carries no block-native content; `textContent` alone is not a body.
 * The result is passed through `sanitizeArticleHtml` once more as a guard.
 */
export async function convertDocumentContent(
  document: Pick<DocumentRecord, "content">,
  options: ConvertDocumentOptions,
): Promise<ConvertedDocument | null> {
  const content = document.content;
  if (!content) return null;
  const cid = overflowBlobCid(content);
  const bytes = cid ? await options.loadBlob(options.did, cid) : null;
  const resolved = inlineOverflow(content, bytes);
  if (resolved === null) return null;
  return finish(convertResolvedContent(resolved, options.did, options.records));
}

const documentValueSchema = z.looseObject({ content: z.unknown().optional() });

/** The record value a Document source holds, parsed losslessly. */
export function parseDocumentSourceRecord(
  source: Pick<DocumentSource, "record">,
) {
  return parseLosslessJson(source.record);
}

/** Content with the retained overflow blob inlined, or null when the source is unusable. */
export function resolveDocumentSourceContent(source: DocumentSource) {
  const value = documentValueSchema.safeParse(
    parseDocumentSourceRecord(source),
  );
  if (!value.success) return null;
  const content = value.data.content;
  if (!isBlockNativeContentType((content as { $type?: string })?.$type))
    return null;
  const cid = overflowBlobCid(content);
  const blob = cid ? source.blobs.find((entry) => entry.cid === cid) : null;
  return inlineOverflow(content, blob ? base64ToBytes(blob.bytes) : null);
}

/** Snapshot records keyed by URI, as the converters read them. */
export function snapshotLookup(
  references: SourceReaderBody["references"],
): RecordLookup {
  const records = new Map(
    references
      .filter((reference) => reference.outcome === "resolved")
      .map((reference) => [
        reference.uri,
        {
          uri: reference.uri,
          cid: reference.cid,
          value: parseLosslessJson(reference.record ?? "null"),
        },
      ]),
  );
  return (uri) => records.get(uri);
}

/**
 * Derives article HTML from a source-form Reader body. Shared by the browser
 * bridge and import, which runs it once for the snippet and first image.
 */
export function convertReaderBody(body: SourceReaderBody, did: string) {
  const content = resolveDocumentSourceContent(body.source);
  if (content === null) return null;
  return finish(
    convertResolvedContent(content, did, snapshotLookup(body.references)),
  );
}

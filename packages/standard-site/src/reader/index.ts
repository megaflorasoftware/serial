import { z } from "zod";
import { AdapterContext, MAX_BLOCK_NESTING_DEPTH } from "./context";
import { boundReaderDocument } from "./bounds";
import type { ReaderDocument, ReaderSummary } from "./model";
import { richTextPlaintext } from "./rich-text";
import { adapterFor } from "./registry";
import { parseDocumentRecord } from "../lexicons";
import type { DocumentRecord } from "../lexicons";
import { parseLosslessJson } from "../lossless-json";
import { documentPublicationUri } from "../record-preview";
import { socialPostReferences } from "./social";
import type { RecordLookup } from "../record-preview";
import { base64ToBytes } from "../reader-body";
import type { DocumentSource, SourceReaderBody } from "../reader-body";

export * from "./model";
export type { FacetFeature, PlatformAdapter } from "./adapter";
export {
  ADAPTER_REFERENCE_COLLECTIONS,
  adapterFor,
  BLOCK_NATIVE_CONTENT_TYPES,
  isBlockNativeContentType,
  PLATFORM_ADAPTERS,
  platformOfContentType,
} from "./registry";
export { PCKT_GALLERY_COLLECTION } from "./pckt";
export {
  boundReaderDocument,
  READER_DOCUMENT_BLOCK_LIMIT,
  READER_DOCUMENT_BUDGET_BYTES,
  readerDocumentBytes,
} from "./bounds";
export { MAX_BLOCK_NESTING_DEPTH };
export { calloutTint } from "./tint";
export {
  handleFromDidDocument,
  socialPost,
  socialPostReferences,
  socialPostUrl,
} from "./social";
export {
  facetArraySchema,
  facetSchema,
  MAX_FOOTNOTE_NESTING_DEPTH,
  resolveRichText,
  richTextContext,
  richTextPlaintext,
  richTextSchema,
} from "./rich-text";
export type { Facet, RichText, RichTextContext } from "./rich-text";

function decodeJsonBlob(bytes: Uint8Array): unknown {
  return parseLosslessJson(new TextDecoder().decode(bytes));
}

/** The one overflow blob a block-native content object may point at. */
export function overflowBlobCid(content: unknown): string | null {
  const adapter = adapterFor(content);
  const parsed = adapter?.schema.safeParse(content);
  return parsed?.success ? adapter!.overflowBlobCid(parsed.data) : null;
}

/** Pulls overflowed content back inline; null when the blob is absent or malformed. */
function inlineOverflow(content: unknown, bytes: Uint8Array | null): unknown {
  const adapter = adapterFor(content);
  const parsed = adapter?.schema.safeParse(content);
  if (!adapter || !parsed?.success) return null;
  const cid = adapter.overflowBlobCid(parsed.data);
  if (cid === null) return parsed.data;
  if (!bytes) return null;
  return adapter.inlineOverflow(parsed.data, decodeJsonBlob(bytes));
}

/**
 * Derives the Reader document from content with no blob overflow left. Null
 * when no registered adapter reads the content's `$type`. Exported for tests
 * and for the reference discovery pass.
 */
export function deriveResolvedContent(
  content: unknown,
  did: string,
  records?: RecordLookup,
): ReaderDocument | null {
  const adapter = adapterFor(content);
  const parsed = adapter?.schema.safeParse(content);
  if (!adapter || !parsed?.success) return null;
  const context = new AdapterContext(did, records, adapter.facetFeatures);
  return boundReaderDocument(
    adapter.derive(parsed.data, context),
    context.footnotes,
  );
}

/** Whether a document's content is a registered platform content type. */
export function isBlockNativeDocument(document: DocumentRecord) {
  return adapterFor(document.content) !== null;
}

export const MAX_EMBEDDED_RECORDS_PER_DOCUMENT = 16;

/**
 * The records a document's body reads while rendering, in encounter order and
 * capped: cards, mentions and galleries. Documents referenced by cards also
 * need their publications, which the caller resolves after these.
 */
export function discoverReferences(content: unknown, did: string) {
  const references = new Set<string>();
  deriveResolvedContent(content, did, (uri) => {
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

/**
 * How many hops past the direct references are followed: a document's
 * publication is one; a post's quoted post and then that post's author is two.
 */
export const MAX_REFERENCE_HOPS = 2;

/**
 * The records one hop out from `references` that are not yet known, capped
 * like the direct set: publications of documents, and for social posts the
 * author's profile and DID document, a note's publication and its quote.
 * Only resolved records reveal their next hop, so callers resolve each hop
 * before asking for the next.
 */
export function nextReferenceHop(
  references: readonly string[],
  known: ReadonlySet<string>,
  records: RecordLookup,
) {
  const next = new Set<string>();
  const add = (uri: string) => {
    if (!known.has(uri) && next.size < MAX_EMBEDDED_RECORDS_PER_DOCUMENT)
      next.add(uri);
  };
  for (const uri of referencedPublications(references, records)) add(uri);
  for (const uri of references)
    for (const reference of socialPostReferences(uri, records)) add(reference);
  return [...next];
}

const documentValueSchema = z.looseObject({ content: z.unknown().optional() });

/** Content with the retained overflow blob inlined, or null when the source is unusable. */
export function resolveDocumentSourceContent(source: DocumentSource) {
  const value = documentValueSchema.safeParse(parseLosslessJson(source.record));
  if (!value.success) return null;
  const content = value.data.content;
  if (!adapterFor(content)) return null;
  const cid = overflowBlobCid(content);
  const blob = cid ? source.blobs.find((entry) => entry.cid === cid) : null;
  return inlineOverflow(content, blob ? base64ToBytes(blob.bytes) : null);
}

/** Snapshot records keyed by URI, as the adapters read them. */
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
 * Derives the Reader document from a source-form Reader body. The browser
 * runs this at render time; import runs it once for the list-view summary.
 * Null when the source carries no block-native content or nothing renders.
 */
export function deriveReaderDocument(
  body: SourceReaderBody,
  did: string,
): ReaderDocument | null {
  const content = resolveDocumentSourceContent(body.source);
  if (content === null) return null;
  const document = deriveResolvedContent(
    content,
    did,
    snapshotLookup(body.references),
  );
  return document && document.blocks.length > 0 ? document : null;
}

/**
 * What list views show for a document: the first paragraph outside quotations
 * and the first image. Callouts and quoted text never become the snippet.
 */
export function summarizeReaderDocument(
  document: ReaderDocument,
): ReaderSummary {
  let firstParagraph: string | null = null;
  let firstImageUrl: string | null = null;
  const visit = (blocks: ReaderDocument["blocks"], quoted: boolean) => {
    for (const block of blocks) {
      if (firstParagraph !== null && firstImageUrl !== null) return;
      switch (block.kind) {
        case "paragraph": {
          const text = richTextPlaintext(block.content).trim();
          if (!quoted && firstParagraph === null && text) firstParagraph = text;
          break;
        }
        case "image":
          if (firstImageUrl === null) firstImageUrl = block.image.url;
          break;
        case "imageGroup":
          if (firstImageUrl === null && block.images[0])
            firstImageUrl = block.images[0].url;
          break;
        case "quotation":
          visit(block.children, true);
          break;
        case "list":
          for (const item of block.items) visit(item.content, quoted);
          break;
        case "table":
          for (const row of block.rows)
            for (const cell of row) visit(cell.content, quoted);
          break;
        default:
          break;
      }
    }
  };
  visit(document.blocks, false);
  return { firstParagraph, firstImageUrl };
}

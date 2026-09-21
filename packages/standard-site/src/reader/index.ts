import { z } from "zod";
import { AdapterContext, MAX_BLOCK_NESTING_DEPTH } from "./context";
import { deriveLeafletContent, leafletContentSchema } from "./leaflet";
import { deriveOffprintContent, offprintContentSchema } from "./offprint";
import { derivePcktItems, pcktBlobSchema, pcktContentSchema } from "./pckt";
import { boundReaderDocument } from "./bounds";
import type { ReaderDocument, ReaderSummary } from "./model";
import { richTextPlaintext } from "./rich-text";
import {
  BLOCK_NATIVE_CONTENT_TYPES,
  isBlockNativeContentType,
  parseDocumentRecord,
} from "../lexicons";
import { parseLosslessJson } from "../lossless-json";
import { documentPublicationUri } from "../record-preview";
import type { RecordLookup } from "../record-preview";
import { base64ToBytes } from "../reader-body";
import type { DocumentSource, SourceReaderBody } from "../reader-body";

export * from "./model";
export {
  boundReaderDocument,
  READER_DOCUMENT_BLOCK_LIMIT,
  READER_DOCUMENT_BUDGET_BYTES,
  readerDocumentBytes,
} from "./bounds";
export { MAX_BLOCK_NESTING_DEPTH };
export { calloutTint } from "./tint";
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
 * Derives the Reader document from content with no blob overflow left. Null
 * when the content is not one of the three block-native shapes. Exported for
 * tests and for the reference discovery pass.
 */
export function deriveResolvedContent(
  content: unknown,
  did: string,
  records?: RecordLookup,
): ReaderDocument | null {
  const context = new AdapterContext(did, records);
  const leaflet = leafletContentSchema.safeParse(content);
  if (leaflet.success)
    return boundReaderDocument(
      deriveLeafletContent(leaflet.data, context),
      context.footnotes,
    );
  const offprint = offprintContentSchema.safeParse(content);
  if (offprint.success)
    return boundReaderDocument(
      deriveOffprintContent(offprint.data, context),
      context.footnotes,
    );
  const pckt = pcktContentSchema.safeParse(content);
  if (pckt.success && pckt.data.items)
    return boundReaderDocument(
      derivePcktItems(pckt.data.items, context),
      context.footnotes,
    );
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

const documentValueSchema = z.looseObject({ content: z.unknown().optional() });

/** Content with the retained overflow blob inlined, or null when the source is unusable. */
export function resolveDocumentSourceContent(source: DocumentSource) {
  const value = documentValueSchema.safeParse(parseLosslessJson(source.record));
  if (!value.success) return null;
  const content = value.data.content;
  if (!isBlockNativeContentType((content as { $type?: string })?.$type))
    return null;
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

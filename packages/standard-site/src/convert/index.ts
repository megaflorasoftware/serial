import { z } from "zod";
import { convertLeafletContent, leafletContentSchema } from "./leaflet";
import { convertOffprintContent, offprintContentSchema } from "./offprint";
import { convertPcktItems, pcktBlobSchema, pcktContentSchema } from "./pckt";
import type { ConvertedDocument } from "./shared";
import { BLOCK_NATIVE_CONTENT_TYPES, type DocumentRecord } from "../lexicons";
import { sanitizeArticleHtml } from "../sanitize";

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
};

const leafletBlobPagesSchema = z.array(
  z.object({
    $type: z.string(),
    blocks: z
      .array(z.object({ block: z.object({ $type: z.string() }).passthrough() }))
      .optional(),
  }),
);

const leafletOverflowSchema = z.object({
  blobPages: z.object({ ref: z.object({ $link: z.string() }) }).optional(),
});

async function decodeJsonBlob(
  loader: BlobLoader,
  did: string,
  cid: string,
): Promise<unknown> {
  const bytes = await loader(did, cid);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function convertLeaflet(
  content: unknown,
  options: ConvertDocumentOptions,
): Promise<ConvertedDocument | null> {
  const overflow = leafletOverflowSchema.safeParse(content);
  if (overflow.success && overflow.data.blobPages) {
    // Consumers must ignore inline `pages` when `blobPages` is set.
    const decoded = await decodeJsonBlob(
      options.loadBlob,
      options.did,
      overflow.data.blobPages.ref.$link,
    );
    const pages = leafletBlobPagesSchema.safeParse(decoded);
    if (!pages.success) return null;
    return convertLeafletContent(
      { $type: BLOCK_NATIVE_CONTENT_TYPES.leaflet, pages: pages.data },
      options.did,
    );
  }
  const parsed = leafletContentSchema.safeParse(content);
  return parsed.success
    ? convertLeafletContent(parsed.data, options.did)
    : null;
}

async function convertPckt(
  content: unknown,
  options: ConvertDocumentOptions,
): Promise<ConvertedDocument | null> {
  const parsed = pcktContentSchema.safeParse(content);
  if (!parsed.success) return null;
  if (parsed.data.items)
    return convertPcktItems(parsed.data.items, options.did);
  if (!parsed.data.blob) return null;
  const decoded = await decodeJsonBlob(
    options.loadBlob,
    options.did,
    parsed.data.blob.ref.$link,
  );
  const items = pcktBlobSchema.safeParse(decoded);
  return items.success ? convertPcktItems(items.data, options.did) : null;
}

function convertOffprint(content: unknown, options: ConvertDocumentOptions) {
  const parsed = offprintContentSchema.safeParse(content);
  return parsed.success
    ? convertOffprintContent(parsed.data, options.did)
    : null;
}

/**
 * Converts a block-native document body to article HTML that is a fixed point of
 * `sanitizeArticleHtml`. Returns null when the document carries no block-native
 * content; `textContent` alone is not a body.
 */
export async function convertDocumentContent(
  document: Pick<DocumentRecord, "content">,
  options: ConvertDocumentOptions,
): Promise<ConvertedDocument | null> {
  const content = document.content;
  if (!content) return null;
  let converted: ConvertedDocument | null;
  switch (content.$type) {
    case BLOCK_NATIVE_CONTENT_TYPES.leaflet:
      converted = await convertLeaflet(content, options);
      break;
    case BLOCK_NATIVE_CONTENT_TYPES.offprint:
      converted = convertOffprint(content, options);
      break;
    case BLOCK_NATIVE_CONTENT_TYPES.pckt:
      converted = await convertPckt(content, options);
      break;
    default:
      return null;
  }
  if (!converted || !converted.html.trim()) return null;
  return { ...converted, html: sanitizeArticleHtml(converted.html) };
}

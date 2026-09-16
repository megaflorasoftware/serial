import { z } from "zod";
import { convertLeafletContent, leafletContentSchema } from "./leaflet";
import { convertOffprintContent, offprintContentSchema } from "./offprint";
import { convertPcktItems, pcktBlobSchema, pcktContentSchema } from "./pckt";
import type { ConvertedDocument, ResolvedRecordCard } from "./shared";
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
  resolveRecord?: (uri: string) => Promise<ResolvedRecordCard | null>;
};

const leafletBlobPagesSchema = z.array(z.unknown());

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

/**
 * Pulls overflowed content back inline. Leaflet consumers must ignore `pages`
 * when `blobPages` is set; pckt uses `blob` only when `items` is absent or empty.
 */
async function resolveContent(
  content: { $type: string } & Record<string, unknown>,
  options: ConvertDocumentOptions,
): Promise<unknown> {
  switch (content.$type) {
    case BLOCK_NATIVE_CONTENT_TYPES.leaflet: {
      const overflow = leafletOverflowSchema.safeParse(content);
      if (!overflow.success || !overflow.data.blobPages) return content;
      const decoded = await decodeJsonBlob(
        options.loadBlob,
        options.did,
        overflow.data.blobPages.ref.$link,
      );
      const pages = leafletBlobPagesSchema.safeParse(decoded);
      return pages.success
        ? { $type: BLOCK_NATIVE_CONTENT_TYPES.leaflet, pages: pages.data }
        : null;
    }
    case BLOCK_NATIVE_CONTENT_TYPES.pckt: {
      const parsed = pcktContentSchema.safeParse(content);
      if (!parsed.success) return null;
      if (parsed.data.items?.length || !parsed.data.blob) return content;
      const decoded = await decodeJsonBlob(
        options.loadBlob,
        options.did,
        parsed.data.blob.ref.$link,
      );
      const items = pcktBlobSchema.safeParse(decoded);
      return items.success
        ? { $type: BLOCK_NATIVE_CONTENT_TYPES.pckt, items: items.data }
        : null;
    }
    default:
      return content;
  }
}

/**
 * Converts content with no blob overflow left. The converters emit HTML that is a
 * fixed point of `sanitizeArticleHtml` by construction; this is exported so tests
 * can assert that on the raw output.
 */
export function convertResolvedContent(
  content: unknown,
  did: string,
  records?: ReadonlyMap<string, ResolvedRecordCard>,
): ConvertedDocument | null {
  const leaflet = leafletContentSchema.safeParse(content);
  if (leaflet.success) return convertLeafletContent(leaflet.data, did, records);
  const offprint = offprintContentSchema.safeParse(content);
  if (offprint.success) return convertOffprintContent(offprint.data, did);
  const pckt = pcktContentSchema.safeParse(content);
  if (pckt.success && pckt.data.items) {
    return convertPcktItems(pckt.data.items, did);
  }
  return null;
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
  const resolved = await resolveContent(content, options);
  if (resolved === null) return null;
  const records = new Map<string, ResolvedRecordCard>();
  if (options.resolveRecord) {
    const uris = embeddedRecordUris(resolved);
    for (const uri of uris) {
      const card = await options.resolveRecord(uri);
      if (card) records.set(uri, card);
    }
  }
  const converted = convertResolvedContent(resolved, options.did, records);
  if (!converted || !converted.html.trim()) return null;
  return { ...converted, html: sanitizeArticleHtml(converted.html) };
}

export const MAX_EMBEDDED_RECORDS_PER_DOCUMENT = 16;

/** Only direct content references are visited; resolved records never enter this walk. */
function embeddedRecordUris(content: unknown) {
  const uris = new Set<string>();
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: content, depth: 0 },
  ];
  let visited = 0;
  while (
    pending.length &&
    visited++ < 50_000 &&
    uris.size < MAX_EMBEDDED_RECORDS_PER_DOCUMENT
  ) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== "object" || depth > 64) continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.$type === "string" &&
      [
        "pub.leaflet.blocks.standardSitePost",
        "pub.leaflet.blocks.standardSitePublication",
      ].includes(record.$type.split("#")[0]!) &&
      typeof record.uri === "string"
    )
      uris.add(record.uri);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (let i = children.length - 1; i >= 0; i--)
      pending.push({ value: children[i], depth: depth + 1 });
  }
  return uris;
}

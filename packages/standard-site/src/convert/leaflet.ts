import { z } from "zod";
import { renderRichText, richTextSchema } from "./facets";
import {
  codeBlock,
  element,
  embedPlaceholder,
  figure,
  interactivePlaceholder,
  linkCard,
  list,
  paragraph,
  taskListItem,
  voidElement,
} from "./html";
import {
  blockName,
  blockSchema,
  blueskyPostCard,
  ConversionContext,
  recordReferenceCard,
  richTextHeading,
  richTextParagraph,
  stringProperty,
  unknownBlock,
  type Block,
} from "./shared";
import type { RecordLookup } from "../record-preview";
import { blobRefSchema } from "../lexicons";
import { sanitizeEmbeddedContent } from "../sanitize";
import { buildPdslsUrl } from "../uris";
import { validEntriesSchema } from "../parse";

const PREFIX = "pub.leaflet.blocks.";

const imageSchema = z.object({
  image: blobRefSchema,
  alt: z.string().optional(),
});

// List items are parsed one level at a time so nesting depth is bounded by the
// context rather than by the schema.
const listItemSchema = z.object({
  content: blockSchema,
  checked: z.boolean().optional(),
  children: z.array(z.unknown()).optional(),
  orderedListChildren: z
    .object({
      children: z.array(z.unknown()),
      startIndex: z.number().optional(),
    })
    .optional(),
  unorderedListChildren: z
    .object({ children: z.array(z.unknown()) })
    .optional(),
});

type LeafletListItem = z.infer<typeof listItemSchema>;

const listSchema = z.object({
  children: z.array(z.unknown()),
  startIndex: z.number().optional(),
});

const pageSchema = z.object({
  $type: z.string(),
  blocks: validEntriesSchema(z.object({ block: blockSchema })).optional(),
});

// Pages parse one at a time so a malformed page drops itself, not the document.
export const leafletContentSchema = z.object({
  $type: z.literal("pub.leaflet.content"),
  pages: z.array(z.unknown()),
});

export type LeafletContent = z.infer<typeof leafletContentSchema>;

const LINEAR_DOCUMENT_TYPE = "pub.leaflet.pages.linearDocument";

/** Blocks the reader can emit, in source order. Canvas and malformed pages are skipped. */
export function* renderableLeafletBlocks(content: LeafletContent) {
  for (const entry of content.pages) {
    const page = pageSchema.safeParse(entry);
    if (!page.success || page.data.$type !== LINEAR_DOCUMENT_TYPE) continue;
    for (const { block } of page.data.blocks ?? []) yield block;
  }
}

/** The record URI for a link-card block the renderer accepts. */
export function embeddedRecordCardUri(block: Block) {
  const name = blockName(block, PREFIX);
  if (name !== "standardSitePost" && name !== "standardSitePublication")
    return null;
  const uri = stringProperty(block, "uri");
  return uri && buildPdslsUrl(uri) ? uri : null;
}

function renderListItemContent(
  item: LeafletListItem,
  context: ConversionContext,
) {
  const contentType = blockName(item.content, PREFIX);
  if (contentType === "image") return renderImage(item.content, context, false);
  const text = richTextSchema.safeParse(item.content);
  if (!text.success || !text.data.plaintext.trim()) return "";
  const inner = renderRichText(text.data, context);
  return contentType === "header" ? element("strong", undefined, inner) : inner;
}

function renderNestedList(
  item: LeafletListItem,
  ordered: boolean,
  context: ConversionContext,
) {
  // Same-kind nesting through `children` takes precedence over the cross-kind
  // fields when both are present.
  if (item.children && item.children.length > 0) {
    return renderList(item.children, ordered, undefined, context);
  }
  if (item.orderedListChildren) {
    return renderList(
      item.orderedListChildren.children,
      true,
      item.orderedListChildren.startIndex,
      context,
    );
  }
  if (item.unorderedListChildren) {
    return renderList(
      item.unorderedListChildren.children,
      false,
      undefined,
      context,
    );
  }
  return "";
}

function renderList(
  items: unknown[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
): string {
  return context.nested(() => {
    const parsed = items
      .map((item) => listItemSchema.safeParse(item))
      .filter((result) => result.success)
      .map((result) => result.data);
    const task = parsed.some((item) => item.checked !== undefined);
    const rendered = parsed
      .map((item) => {
        const inner =
          renderListItemContent(item, context) +
          renderNestedList(item, ordered, context);
        if (!inner) return "";
        return item.checked !== undefined
          ? taskListItem(item.checked, inner)
          : element("li", undefined, inner);
      })
      .filter((item) => item !== "");
    return list(ordered, rendered, { start, task });
  });
}

function renderImage(
  value: unknown,
  context: ConversionContext,
  wrap: boolean,
) {
  const parsed = imageSchema.safeParse(value);
  if (!parsed.success) return "";
  const img = context.blobImage(parsed.data.image.ref.$link, parsed.data.alt);
  if (!img) return "";
  return wrap ? figure(img, undefined) : img;
}

/** Inline HTML keeps only what the article schema permits; nothing left means a placeholder. */
function renderHtmlBlock(html: string, context: ConversionContext) {
  let sanitized: ReturnType<typeof sanitizeEmbeddedContent>;
  try {
    sanitized = sanitizeEmbeddedContent(html);
  } catch (error) {
    // The HTML parser and sanitizer use recursion on author-controlled nesting.
    // Keep this unsupported block local without hiding other conversion errors.
    if (
      error instanceof RangeError &&
      error.message === "Maximum call stack size exceeded"
    ) {
      return interactivePlaceholder(null);
    }
    throw error;
  }
  if (sanitized.firstParagraph) context.noteParagraph(sanitized.firstParagraph);
  if (sanitized.firstImageUrl) context.noteImage(sanitized.firstImageUrl);
  return sanitized.html.trim() || interactivePlaceholder(null);
}

function renderBlock(block: Block, context: ConversionContext): string {
  switch (blockName(block, PREFIX)) {
    case "text":
      return richTextParagraph(block, context);
    case "header":
      return richTextHeading(block, context);
    case "blockquote": {
      const text = richTextSchema.safeParse(block);
      if (!text.success || !text.data.plaintext.trim()) return "";
      return element(
        "blockquote",
        undefined,
        paragraph(renderRichText(text.data, context)),
      );
    }
    case "image":
      return renderImage(block, context, true);
    case "imageGallery": {
      // Entries parse one at a time so a malformed image drops itself, not the gallery.
      const images = z.array(z.unknown()).safeParse(block.images);
      if (!images.success) return "";
      return images.data
        .map((entry) => renderImage(entry, context, true))
        .join("");
    }
    case "unorderedList":
    case "orderedList": {
      const parsed = listSchema.safeParse(block);
      if (!parsed.success) return "";
      return renderList(
        parsed.data.children,
        blockName(block, PREFIX) === "orderedList",
        parsed.data.startIndex,
        context,
      );
    }
    case "code": {
      const code = stringProperty(block, "plaintext");
      return code === undefined
        ? ""
        : codeBlock(code, stringProperty(block, "language"));
    }
    case "math": {
      const tex = stringProperty(block, "tex");
      return tex === undefined ? "" : codeBlock(tex, "tex");
    }
    case "horizontalRule":
      return voidElement("hr");
    case "website": {
      const src = stringProperty(block, "src");
      if (src && buildPdslsUrl(src)) return recordReferenceCard(src, context);
      const preview = blobRefSchema.safeParse(block.previewImage);
      return linkCard({
        href: stringProperty(block, "src") ?? "",
        title: stringProperty(block, "title"),
        description: stringProperty(block, "description"),
        imageUrl: preview.success
          ? context.imageUrl(preview.data.ref.$link)
          : undefined,
      });
    }
    case "button":
      return linkCard({
        href: stringProperty(block, "url") ?? "",
        title: stringProperty(block, "text"),
      });
    case "bskyPost":
      return blueskyPostCard(block.postRef);
    case "standardSitePost":
    case "standardSitePublication": {
      const uri = embeddedRecordCardUri(block);
      if (!uri) return "";
      return recordReferenceCard(
        uri,
        context,
        block.size,
        blockName(block, PREFIX) === "standardSitePost"
          ? "Embedded document"
          : "Embedded publication",
      );
    }
    case "iframe": {
      // The deprecated inline `html` takes precedence over `url`.
      const html = stringProperty(block, "html");
      if (html?.trim()) return renderHtmlBlock(html, context);
      const url = stringProperty(block, "url");
      return url ? embedPlaceholder(url, url) : interactivePlaceholder(null);
    }
    case "html": {
      const html = stringProperty(block, "html");
      return html === undefined ? "" : renderHtmlBlock(html, context);
    }
    case "page":
    case "poll":
    case "postsList":
    case "signup":
    case "membersOnlyDelimiter":
      return "";
    default:
      return unknownBlock(block, context);
  }
}

/**
 * Converts `pub.leaflet.content` to article HTML. Only linear-document pages are
 * rendered; canvas pages carry positioned blocks with no reading order.
 */
export function convertLeafletContent(
  content: LeafletContent,
  did: string,
  records?: RecordLookup,
) {
  const context = new ConversionContext(did, records);
  let html = "";
  for (const block of renderableLeafletBlocks(content))
    html += renderBlock(block, context);
  return context.finish(html);
}

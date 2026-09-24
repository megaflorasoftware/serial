import { z } from "zod";
import {
  AdapterContext,
  block,
  blockName,
  blockSchema,
  blueskyPostBlock,
  embedBlock,
  image,
  linkCard,
  naturalGrid,
  notice,
  readAlign,
  readAspectRatio,
  readFrameHeight,
  recordPreviewBlock,
  recordReferenceUri,
  richTextHeading,
  richTextParagraph,
  stringProperty,
  unknownBlock,
  type Block,
} from "./context";
import type {
  ReaderAlign,
  ReaderBlock,
  ReaderImageGroupLayout,
  ReaderListItem,
} from "./model";
import { richTextSchema } from "./rich-text";
import { blobRefSchema } from "../lexicons";
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

const linearBlockSchema = z.object({
  block: blockSchema,
  alignment: z.unknown().optional(),
});

const pageSchema = z.object({
  $type: z.string(),
  blocks: validEntriesSchema(linearBlockSchema).optional(),
});

// Pages parse one at a time so a malformed page drops itself, not the document.
export const leafletContentSchema = z.object({
  $type: z.literal("pub.leaflet.content"),
  pages: z.array(z.unknown()),
});

export type LeafletContent = z.infer<typeof leafletContentSchema>;

const LINEAR_DOCUMENT_TYPE = "pub.leaflet.pages.linearDocument";
const CANVAS_TYPE = "pub.leaflet.pages.canvas";

/** The record URI for a link-card block the reader accepts. */
export function embeddedRecordCardUri(value: Block) {
  const name = blockName(value, PREFIX);
  if (name !== "standardSitePost" && name !== "standardSitePublication")
    return null;
  return recordReferenceUri(stringProperty(value, "uri"));
}

/**
 * Leaflet's `grid` is the default and any unknown format falls back to it; a
 * `strip` is a full-width column. The record's own gap and max width are not
 * carried: the reader's grid spacing and column rule apply everywhere.
 */
function galleryLayout(
  format: string | undefined,
  count: number,
): ReaderImageGroupLayout {
  if (format === "strip") return { mode: "stack" };
  if (format === "carousel") return { mode: "carousel" };
  return naturalGrid(count);
}

function imageBlock(
  value: unknown,
  context: AdapterContext,
  align: ReaderAlign | null,
): ReaderBlock | null {
  const parsed = imageSchema.safeParse(value);
  if (!parsed.success) return null;
  const url = context.imageUrl(parsed.data.image.ref.$link);
  if (!url) return null;
  const source = value as Block;
  return block(value, {
    kind: "image",
    image: image(url, {
      alt: parsed.data.alt,
      aspectRatio: source.aspectRatio,
      width: source.width,
      fullBleed: source.fullBleed,
    }),
    caption: null,
    align,
  });
}

function listItemContent(
  item: LeafletListItem,
  context: AdapterContext,
): ReaderBlock | null {
  const contentType = blockName(item.content, PREFIX);
  if (contentType === "image") return imageBlock(item.content, context, null);
  const paragraph = richTextParagraph(item.content, context);
  if (!paragraph || paragraph.kind !== "paragraph") return null;
  if (contentType !== "header") return paragraph;
  // A header inside a list item reads as emphasis, not as a document heading.
  return {
    ...paragraph,
    content: paragraph.content.map((inline) =>
      inline.kind === "text"
        ? { ...inline, marks: { ...inline.marks, bold: true } }
        : inline,
    ),
  };
}

function nestedList(
  item: LeafletListItem,
  ordered: boolean,
  context: AdapterContext,
): ReaderBlock | null {
  // Same-kind nesting through `children` takes precedence over the cross-kind
  // fields when both are present.
  if (item.children && item.children.length > 0)
    return list(item, item.children, ordered, undefined, context);
  if (item.orderedListChildren)
    return list(
      item,
      item.orderedListChildren.children,
      true,
      item.orderedListChildren.startIndex,
      context,
    );
  if (item.unorderedListChildren)
    return list(
      item,
      item.unorderedListChildren.children,
      false,
      undefined,
      context,
    );
  return null;
}

function list(
  source: unknown,
  entries: unknown[],
  ordered: boolean,
  start: number | undefined,
  context: AdapterContext,
): ReaderBlock | null {
  return context.nested(
    () => {
      const items: ReaderListItem[] = [];
      for (const entry of entries) {
        const parsed = listItemSchema.safeParse(entry);
        if (!parsed.success) continue;
        const content = [
          listItemContent(parsed.data, context),
          nestedList(parsed.data, ordered, context),
        ].filter((value): value is ReaderBlock => value !== null);
        if (content.length === 0) continue;
        items.push({ content, checked: parsed.data.checked ?? null });
      }
      if (items.length === 0) return null;
      return block(source, {
        kind: "list",
        ordered,
        start: ordered && Number.isSafeInteger(start) ? start! : null,
        items,
      });
    },
    () => notice(source, "depth"),
  );
}

function htmlBlock(source: Block, html: string): ReaderBlock {
  return block(source, {
    kind: "html",
    html,
    height: readFrameHeight(source.height),
    aspectRatio: readAspectRatio(source.aspectRatio),
  });
}

function convertBlock(
  value: Block,
  align: ReaderAlign | null,
  context: AdapterContext,
): ReaderBlock | null {
  const name = blockName(value, PREFIX);
  switch (name) {
    case "text":
      return richTextParagraph(value, context, align);
    case "header":
      return richTextHeading(value, context, align);
    case "blockquote": {
      const paragraph = richTextParagraph(value, context);
      return paragraph
        ? block(value, { kind: "quotation", children: [paragraph], align })
        : null;
    }
    case "image":
      return imageBlock(value, context, align);
    case "imageGallery": {
      // Entries parse one at a time so a malformed image drops itself, not the gallery.
      const entries = z.array(z.unknown()).safeParse(value.images);
      if (!entries.success) return null;
      const images = entries.data
        .map((entry) => imageBlock(entry, context, null))
        .filter((entry) => entry?.kind === "image")
        .map((entry) => entry.image);
      if (images.length === 0) return null;
      return block(value, {
        kind: "imageGroup",
        images,
        title: null,
        caption: null,
        layout: galleryLayout(stringProperty(value, "format"), images.length),
        align,
      });
    }
    case "unorderedList":
    case "orderedList": {
      const parsed = listSchema.safeParse(value);
      if (!parsed.success) return null;
      return list(
        value,
        parsed.data.children,
        name === "orderedList",
        parsed.data.startIndex,
        context,
      );
    }
    case "code": {
      const code = stringProperty(value, "plaintext");
      return code === undefined
        ? null
        : block(value, {
            kind: "code",
            code,
            language: stringProperty(value, "language") ?? null,
            align,
          });
    }
    case "math": {
      const tex = stringProperty(value, "tex");
      return tex === undefined
        ? null
        : block(value, { kind: "math", tex, align });
    }
    case "horizontalRule":
      return block(value, { kind: "divider" });
    case "website": {
      const src = stringProperty(value, "src");
      const record = recordReferenceUri(src);
      if (record) return recordPreviewBlock(value, record, context);
      const preview = blobRefSchema.safeParse(value.previewImage);
      return linkCard(
        value,
        {
          href: src,
          title: stringProperty(value, "title"),
          description: stringProperty(value, "description"),
          imageUrl: preview.success
            ? context.imageUrl(preview.data.ref.$link)
            : null,
        },
        align,
      );
    }
    case "button":
      return linkCard(
        value,
        {
          href: stringProperty(value, "url"),
          title: stringProperty(value, "text"),
        },
        align,
      );
    case "bskyPost":
      return blueskyPostBlock(value, value.postRef, context);
    case "standardSitePost":
    case "standardSitePublication": {
      const uri = embeddedRecordCardUri(value);
      if (!uri) return null;
      return recordPreviewBlock(
        value,
        uri,
        context,
        value.size,
        name === "standardSitePost"
          ? "Embedded document"
          : "Embedded publication",
      );
    }
    case "iframe": {
      // The deprecated inline `html` takes precedence over `url`.
      const html = stringProperty(value, "html");
      if (html?.trim()) return htmlBlock(value, html);
      return embedBlock(
        value,
        {
          href: stringProperty(value, "url"),
          embedUrl: stringProperty(value, "url"),
          height: value.height,
          aspectRatio: value.aspectRatio,
        },
        align,
      );
    }
    case "html": {
      const html = stringProperty(value, "html");
      return html === undefined ? null : htmlBlock(value, html);
    }
    case "page":
    case "postsList":
    case "signup":
      return null;
    case "poll":
      return notice(value, "unsupported");
    case "membersOnlyDelimiter":
      return notice(value, "membersOnly");
    default:
      return unknownBlock(value, context);
  }
}

/**
 * Derives `pub.leaflet.content`. Linear pages render in order with each
 * wrapper's alignment applied to its block; a canvas page becomes one notice
 * because its positioned blocks have no reading order.
 */
export function deriveLeafletContent(
  content: LeafletContent,
  context: AdapterContext,
): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  for (const entry of content.pages) {
    const page = pageSchema.safeParse(entry);
    if (!page.success) continue;
    if (page.data.$type === CANVAS_TYPE) {
      blocks.push(notice(entry, "canvas"));
      continue;
    }
    if (page.data.$type !== LINEAR_DOCUMENT_TYPE) continue;
    for (const wrapper of page.data.blocks ?? []) {
      const derived = convertBlock(
        wrapper.block,
        readAlign(wrapper.alignment),
        context,
      );
      if (derived) blocks.push(derived);
    }
  }
  return blocks;
}

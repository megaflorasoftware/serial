import { z } from "zod";
import {
  AdapterContext,
  block,
  blockArraySchema,
  blockName,
  blueskyPostBlock,
  embedBlock,
  image,
  linkCard,
  naturalGrid,
  notice,
  readAlign,
  recordPreviewBlock,
  recordReferenceUri,
  richTextHeading,
  richTextParagraph,
  stringProperty,
  unknownBlock,
  type Block,
} from "./context";
import type {
  ReaderBlock,
  ReaderGridRatio,
  ReaderImage,
  ReaderImageGroupLayout,
  ReaderListItem,
  ReaderRichText,
} from "./model";
import { facetArraySchema, richTextSchema } from "./rich-text";
import { blobRefSchema } from "../lexicons";
import { calloutTint } from "./tint";

const PREFIX = "app.offprint.block.";

// List items are parsed one level at a time so nesting depth is bounded by the
// context rather than by the schema.
const listItemSchema = z.object({
  content: richTextSchema.optional(),
  checked: z.boolean().optional(),
  children: z.array(z.unknown()).optional(),
});

const listSchema = z.object({
  children: z.array(z.unknown()),
  start: z.number().optional(),
});

const imageSchema = z.object({
  image: blobRefSchema.optional(),
  alt: z.string().optional(),
  caption: z.string().optional(),
});

// The lexicon names the grid image blob `blob`; published records use `image`.
const gridImageSchema = z.object({
  blob: blobRefSchema.optional(),
  image: blobRefSchema.optional(),
  alt: z.string().optional(),
  aspectRatio: z.unknown().optional(),
});

const imageSetSchema = z.object({
  images: z.array(z.unknown()),
  caption: z.string().optional(),
  gridRows: z.number().optional(),
  aspectRatio: z.string().optional(),
});

const GRID_RATIOS = new Set(["landscape", "portrait", "square", "mosaic"]);

export const offprintContentSchema = z.object({
  $type: z.literal("app.offprint.content"),
  items: blockArraySchema,
});

export type OffprintContent = z.infer<typeof offprintContentSchema>;

function caption(
  text: string | undefined,
  facets: unknown,
  context: AdapterContext,
): ReaderRichText | null {
  if (!text?.trim()) return null;
  // Malformed caption facets lose the formatting, not the caption.
  const parsed = facetArraySchema.safeParse(facets);
  return context.richText({
    plaintext: text,
    facets: parsed.success ? parsed.data : undefined,
  });
}

function listItems(
  entries: unknown[],
  ordered: boolean,
  task: boolean,
  context: AdapterContext,
): ReaderListItem[] {
  const items: ReaderListItem[] = [];
  for (const entry of entries) {
    const parsed = listItemSchema.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;
    const content: ReaderBlock[] = [];
    if (item.content?.plaintext.trim())
      content.push(
        block(entry, {
          kind: "paragraph",
          content: context.richText(item.content),
        }),
      );
    if (item.children?.length) {
      const nested = list(
        entry,
        item.children,
        ordered,
        undefined,
        task,
        context,
      );
      if (nested) content.push(nested);
    }
    if (content.length === 0) continue;
    items.push({ content, checked: task ? item.checked === true : null });
  }
  return items;
}

function list(
  source: unknown,
  entries: unknown[],
  ordered: boolean,
  start: number | undefined,
  task: boolean,
  context: AdapterContext,
): ReaderBlock | null {
  return context.nested(
    () => {
      const items = listItems(entries, ordered, task, context);
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

function imageBlock(value: Block, context: AdapterContext): ReaderBlock | null {
  const parsed = imageSchema.safeParse(value);
  if (!parsed.success || !parsed.data.image) return null;
  const url = context.imageUrl(parsed.data.image.ref.$link);
  if (!url) return null;
  return block(value, {
    kind: "image",
    image: image(url, {
      alt: parsed.data.alt,
      aspectRatio: value.aspectRatio,
      width: value.width,
    }),
    caption: caption(parsed.data.caption, value.captionFacets, context),
    align: readAlign(value.alignment),
  });
}

/**
 * Offprint grids fill their rows in order, so the column count follows from
 * the row count; a two-row mosaic gives its first image both rows.
 */
function gridColumns(count: number, rows: number, mosaic: boolean) {
  if (mosaic && rows === 2 && count > 1) return 1 + Math.ceil((count - 1) / 2);
  return Math.max(1, Math.ceil(count / rows));
}

/** A grid keeps Offprint's fixed cells; a carousel pages; a diff is its two images side by side. */
function setLayout(
  name: string,
  set: z.infer<typeof imageSetSchema>,
  count: number,
): ReaderImageGroupLayout {
  if (name === "imageCarousel") return { mode: "carousel" };
  if (name !== "imageGrid") return naturalGrid(count);
  const ratio =
    set.aspectRatio && GRID_RATIOS.has(set.aspectRatio)
      ? (set.aspectRatio as ReaderGridRatio)
      : "landscape";
  const rows = set.gridRows === 2 ? 2 : 1;
  return {
    mode: "grid",
    columns: gridColumns(count, rows, ratio === "mosaic"),
    ratio,
  };
}

function imageSet(
  name: string,
  value: Block,
  context: AdapterContext,
): ReaderBlock | null {
  const parsed = imageSetSchema.safeParse(value);
  if (!parsed.success) return null;
  const images: ReaderImage[] = [];
  for (const entry of parsed.data.images) {
    const item = gridImageSchema.safeParse(entry);
    if (!item.success) continue;
    const blob = item.data.blob ?? item.data.image;
    const url = blob ? context.imageUrl(blob.ref.$link) : null;
    if (!url) continue;
    images.push(
      image(url, { alt: item.data.alt, aspectRatio: item.data.aspectRatio }),
    );
  }
  if (images.length === 0) return null;
  return block(value, {
    kind: "imageGroup",
    images,
    title: null,
    caption: caption(parsed.data.caption, undefined, context),
    layout: setLayout(name, parsed.data, images.length),
    align: readAlign(value.alignment),
  });
}

function convertBlock(
  value: Block,
  context: AdapterContext,
): ReaderBlock | null {
  const name = blockName(value, PREFIX);
  switch (name) {
    case "text":
      return richTextParagraph(value, context, readAlign(value.textAlign));
    case "heading":
      return richTextHeading(value, context, readAlign(value.textAlign));
    case "blockquote": {
      const items = blockArraySchema.safeParse(value.content);
      if (!items.success) return null;
      const children = context.nestedBlocks(
        () => deriveOffprintBlocks(items.data, context),
        value,
      );
      return children.length
        ? block(value, { kind: "quotation", children })
        : null;
    }
    case "callout": {
      const text = richTextSchema.safeParse(value);
      if (!text.success || !text.data.plaintext.trim()) return null;
      const color = stringProperty(value, "color") ?? null;
      return block(value, {
        kind: "callout",
        emoji: stringProperty(value, "emoji") ?? null,
        color,
        tint: calloutTint(color),
        content: context.richText(text.data),
      });
    }
    case "bulletList":
    case "orderedList": {
      const parsed = listSchema.safeParse(value);
      if (!parsed.success) return null;
      return list(
        value,
        parsed.data.children,
        name === "orderedList",
        parsed.data.start,
        false,
        context,
      );
    }
    case "taskList": {
      const parsed = listSchema.safeParse(value);
      if (!parsed.success) return null;
      return list(value, parsed.data.children, false, undefined, true, context);
    }
    case "codeBlock": {
      const code = stringProperty(value, "code");
      return code === undefined
        ? null
        : block(value, {
            kind: "code",
            code,
            language: stringProperty(value, "language") ?? null,
          });
    }
    case "mathBlock": {
      const tex = stringProperty(value, "tex");
      return tex === undefined ? null : block(value, { kind: "math", tex });
    }
    case "horizontalRule":
      return block(value, { kind: "divider" });
    case "image":
      return imageBlock(value, context);
    case "imageGrid":
    case "imageCarousel":
    case "imageDiff":
      return imageSet(name, value, context);
    case "webBookmark": {
      const href = stringProperty(value, "href");
      const record = recordReferenceUri(href);
      if (record) return recordPreviewBlock(value, record, context);
      const preview = blobRefSchema.safeParse(value.preview);
      return linkCard(value, {
        href,
        title: stringProperty(value, "title"),
        description: stringProperty(value, "description"),
        imageUrl: preview.success
          ? context.imageUrl(preview.data.ref.$link)
          : null,
      });
    }
    case "webEmbed":
      return embedBlock(
        value,
        {
          href: stringProperty(value, "href"),
          embedUrl: stringProperty(value, "embedUrl"),
          height: value.embedHeight,
        },
        readAlign(value.alignment),
      );
    case "button":
      return linkCard(
        value,
        {
          href: stringProperty(value, "href"),
          title: stringProperty(value, "text"),
          description: stringProperty(value, "caption"),
        },
        readAlign(value.alignment),
      );
    case "blueskyPost":
      return blueskyPostBlock(value, value.post, context);
    case "component":
      return notice(value, "unsupported");
    default:
      return unknownBlock(value, context);
  }
}

function deriveOffprintBlocks(items: Block[], context: AdapterContext) {
  return items
    .map((item) => convertBlock(item, context))
    .filter((item): item is ReaderBlock => item !== null);
}

export function deriveOffprintContent(
  content: OffprintContent,
  context: AdapterContext,
): ReaderBlock[] {
  return deriveOffprintBlocks(content.items, context);
}

import { buildPdslsUrl } from "../uris";
import { z } from "zod";
import { facetArraySchema, renderRichText, richTextSchema } from "./facets";
import {
  codeBlock,
  element,
  embedPlaceholder,
  escapeText,
  figure,
  linkCard,
  list,
  paragraph,
  taskListItem,
  voidElement,
} from "./html";
import {
  blockName,
  blockArraySchema,
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
});

const imageSetSchema = z.object({
  images: z.array(z.unknown()),
  caption: z.string().optional(),
});

export const offprintContentSchema = z.object({
  $type: z.literal("app.offprint.content"),
  items: blockArraySchema,
});

export type OffprintContent = z.infer<typeof offprintContentSchema>;

function renderListItems(
  items: unknown[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
  task: boolean,
): string {
  return context.nested(() => {
    const rendered = items
      .map((item) => listItemSchema.safeParse(item))
      .filter((result) => result.success)
      .map(({ data: item }) => {
        const inner = item.content?.plaintext.trim()
          ? renderRichText(item.content, context)
          : "";
        const nested = item.children?.length
          ? renderListItems(item.children, ordered, undefined, context, task)
          : "";
        if (!inner && !nested) return "";
        return task
          ? taskListItem(item.checked === true, inner + nested)
          : element("li", undefined, inner + nested);
      })
      .filter((item) => item !== "");
    return list(ordered, rendered, { start, task });
  });
}

function renderImage(value: unknown, context: ConversionContext) {
  const parsed = imageSchema.safeParse(value);
  if (!parsed.success || !parsed.data.image) return "";
  const img = context.blobImage(parsed.data.image.ref.$link, parsed.data.alt);
  if (!img) return "";
  // Malformed caption facets lose the formatting, not the image.
  const captionFacets = facetArraySchema.safeParse(
    (value as { captionFacets?: unknown }).captionFacets,
  );
  const caption = parsed.data.caption
    ? renderRichText(
        {
          plaintext: parsed.data.caption,
          facets: captionFacets.success ? captionFacets.data : undefined,
        },
        context,
      )
    : undefined;
  return figure(img, caption);
}

/** Grids, carousels, and diffs all become one figure holding a run of images. */
function renderImageSet(value: unknown, context: ConversionContext) {
  const parsed = imageSetSchema.safeParse(value);
  if (!parsed.success) return "";
  const rendered = parsed.data.images
    .map((entry) => gridImageSchema.safeParse(entry))
    .filter((result) => result.success)
    .map(({ data: entry }) => {
      const blob = entry.blob ?? entry.image;
      return blob ? context.blobImage(blob.ref.$link, entry.alt) : "";
    })
    .join("");
  if (!rendered) return "";
  const caption = parsed.data.caption?.trim();
  return figure(rendered, caption ? escapeText(caption) : undefined);
}

function renderBlock(block: Block, context: ConversionContext): string {
  switch (blockName(block, PREFIX)) {
    case "text":
      return richTextParagraph(block, context);
    case "heading":
      return richTextHeading(block, context);
    case "blockquote": {
      const items = blockArraySchema.safeParse(block.content);
      if (!items.success) return "";
      const inner = context.aside(() =>
        context.nested(() =>
          items.data.map((item) => renderBlock(item, context)).join(""),
        ),
      );
      return inner ? element("blockquote", undefined, inner) : "";
    }
    case "callout": {
      const text = richTextSchema.safeParse(block);
      if (!text.success) return "";
      if (!text.data.plaintext.trim()) return "";
      const emoji = stringProperty(block, "emoji");
      const prefix = emoji ? `${escapeText(emoji)} ` : "";
      return element(
        "blockquote",
        undefined,
        paragraph(prefix + renderRichText(text.data, context)),
      );
    }
    case "bulletList":
    case "orderedList": {
      const parsed = listSchema.safeParse(block);
      if (!parsed.success) return "";
      return renderListItems(
        parsed.data.children,
        blockName(block, PREFIX) === "orderedList",
        parsed.data.start,
        context,
        false,
      );
    }
    case "taskList": {
      const parsed = listSchema.safeParse(block);
      if (!parsed.success) return "";
      return renderListItems(
        parsed.data.children,
        false,
        undefined,
        context,
        true,
      );
    }
    case "codeBlock": {
      const code = stringProperty(block, "code");
      return code === undefined
        ? ""
        : codeBlock(code, stringProperty(block, "language"));
    }
    case "mathBlock": {
      const tex = stringProperty(block, "tex");
      return tex === undefined ? "" : codeBlock(tex, "tex");
    }
    case "horizontalRule":
      return voidElement("hr");
    case "image":
      return renderImage(block, context);
    case "imageGrid":
    case "imageCarousel":
    case "imageDiff":
      return renderImageSet(block, context);
    case "webBookmark": {
      const href = stringProperty(block, "href");
      if (href && buildPdslsUrl(href))
        return recordReferenceCard(href, context);
      const preview = blobRefSchema.safeParse(block.preview);
      return linkCard({
        href: stringProperty(block, "href") ?? "",
        title: stringProperty(block, "title"),
        description: stringProperty(block, "description"),
        imageUrl: preview.success
          ? context.imageUrl(preview.data.ref.$link)
          : undefined,
      });
    }
    case "webEmbed":
      return embedPlaceholder(
        stringProperty(block, "embedUrl"),
        stringProperty(block, "href"),
      );
    case "button":
      return linkCard({
        href: stringProperty(block, "href") ?? "",
        title: stringProperty(block, "text"),
        description: stringProperty(block, "caption"),
      });
    case "blueskyPost":
      return blueskyPostCard(block.post);
    case "component":
      return "";
    default:
      return unknownBlock(block, context);
  }
}

export function convertOffprintContent(
  content: OffprintContent,
  did: string,
  records?: RecordLookup,
) {
  const context = new ConversionContext(did, records);
  const html = content.items.map((item) => renderBlock(item, context)).join("");
  return context.finish(html);
}

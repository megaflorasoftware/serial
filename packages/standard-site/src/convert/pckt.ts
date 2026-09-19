import { buildPdslsUrl } from "../uris";
import { z } from "zod";
import { renderRichText, richTextSchema } from "./facets";
import {
  codeBlock,
  element,
  embedPlaceholder,
  escapeText,
  figure,
  interactivePlaceholder,
  linkCard,
  list,
  paragraph,
  safeSourceUrl,
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
import { strongRefSchema, blobRefSchema, listedRecordSchema } from "../lexicons";
import { buildBlueskyProfileUrl } from "../uris";
import { validEntriesSchema } from "../parse";

const PREFIX = "blog.pckt.block.";

const containerSchema = z.object({ content: blockArraySchema });

const imageAttrsSchema = z.object({
  src: z.string(),
  blob: blobRefSchema.optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
});

const cellSchema = z.object({
  $type: z.string(),
  content: blockArraySchema,
  colspan: z.number().optional(),
  rowspan: z.number().optional(),
});

const tableSchema = z.object({
  content: validEntriesSchema(
    z.object({ content: validEntriesSchema(cellSchema) }),
  ),
});

export const pcktContentSchema = z.object({
  $type: z.literal("blog.pckt.content"),
  items: blockArraySchema.optional(),
  blob: blobRefSchema.optional(),
  references: z.array(blobRefSchema).optional(),
});

export type PcktContent = z.infer<typeof pcktContentSchema>;

/** The blob JSON either is the items array or wraps it as `{ items }`. */
export const pcktBlobSchema = z.union([
  blockArraySchema,
  z.object({ items: blockArraySchema }).transform((value) => value.items),
]);

/**
 * A single text block stays inline. Multiple paragraphs retain their boundaries;
 * all other blocks keep their markup. Callers run this inside `context.nested`.
 */
function renderInline(blocks: Block[], context: ConversionContext) {
  const prepared = blocks.map((block) => {
    const text =
      blockName(block, PREFIX) === "text"
        ? richTextSchema.safeParse(block)
        : null;
    return { block, text: text?.success ? text.data : null };
  });
  const hasMultipleParagraphs =
    prepared.filter((entry) => entry.text?.plaintext.trim()).length > 1;
  return prepared
    .map(({ block, text }) => {
      if (!text) return renderBlock(block, context);
      if (!text.plaintext.trim()) return "";
      if (hasMultipleParagraphs) context.noteParagraph(text.plaintext);
      const html = renderRichText(text, context);
      return hasMultipleParagraphs ? paragraph(html) : html;
    })
    .join("");
}

function renderBlocks(blocks: Block[], context: ConversionContext) {
  return context.nested(() =>
    blocks.map((block) => renderBlock(block, context)).join(""),
  );
}

function renderImage(value: unknown, context: ConversionContext) {
  const attrs = imageAttrsSchema.safeParse(value);
  if (!attrs.success) return "";
  const { src, blob, alt, title } = attrs.data;
  const cid =
    blob?.ref.$link ?? (src.startsWith("blob:") ? src.slice(5) : null);
  const url = cid ? context.imageUrl(cid) : safeSourceUrl(src);
  if (!url) return "";
  context.noteImage(url);
  // `title` is hover text per the lexicon, not a caption.
  return voidElement("img", { src: url, alt: alt ?? "", title });
}

function renderImageAttrs(value: unknown, context: ConversionContext) {
  const img = renderImage(value, context);
  return img ? figure(img, undefined) : "";
}

const gallerySchema = z.object({
  images: z.array(z.unknown()),
  caption: z.string().optional(),
});

/** A gallery block points at a standalone record; its images render as one figure. */
function renderGallery(block: Block, context: ConversionContext) {
  const uri = stringProperty(block, "ref");
  if (!uri || !buildPdslsUrl(uri)) return "";
  const record = listedRecordSchema.safeParse(context.records(uri));
  const gallery = record.success
    ? gallerySchema.safeParse(record.data.value)
    : null;
  if (!gallery?.success) return "";
  const rendered = gallery.data.images
    .map((image) => renderImage(image, context))
    .join("");
  if (!rendered) return "";
  const caption = gallery.data.caption?.trim();
  return figure(rendered, caption ? escapeText(caption) : undefined);
}

function renderListItems(
  blocks: Block[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
) {
  return context.nested(() => {
    const items = blocks
      .map((item) => {
        const parsed = containerSchema.safeParse(item);
        return parsed.success ? renderInline(parsed.data.content, context) : "";
      })
      .filter((inner) => inner !== "")
      .map((inner) => element("li", undefined, inner));
    return list(ordered, items, { start });
  });
}

function renderTaskItems(blocks: Block[], context: ConversionContext) {
  return context.nested(() => {
    const items = blocks
      .map((item) => {
        const inner = containerSchema.safeParse(item);
        const content = inner.success
          ? renderInline(inner.data.content, context)
          : "";
        return content ? taskListItem(item.checked === true, content) : "";
      })
      .filter((item) => item !== "");
    return list(false, items, { task: true });
  });
}

function renderTable(block: Block, context: ConversionContext) {
  const parsed = tableSchema.safeParse(block);
  if (!parsed.success) return "";
  const span = (value: number | undefined) =>
    value !== undefined && Number.isSafeInteger(value) && value > 1
      ? String(value)
      : undefined;
  return context.nested(() => {
    let hasContent = false;
    const rows = parsed.data.content.map((row) => {
      const cells = row.content.map((cell) => {
        const inner = renderInline(cell.content, context);
        if (inner) hasContent = true;
        return element(
          blockName(cell, PREFIX) === "tableHeader" ? "th" : "td",
          { colspan: span(cell.colspan), rowspan: span(cell.rowspan) },
          inner,
        );
      });
      return element("tr", undefined, cells.join(""));
    });
    if (!hasContent) return "";
    return element(
      "table",
      undefined,
      element("tbody", undefined, rows.join("")),
    );
  });
}

function renderBlock(block: Block, context: ConversionContext): string {
  switch (blockName(block, PREFIX)) {
    case "text":
      return richTextParagraph(block, context);
    case "heading":
      return richTextHeading(block, context);
    case "blockquote": {
      const parsed = containerSchema.safeParse(block);
      if (!parsed.success) return "";
      const inner = context.aside(() =>
        renderBlocks(parsed.data.content, context),
      );
      return inner ? element("blockquote", undefined, inner) : "";
    }
    case "bulletList":
    case "orderedList": {
      const parsed = containerSchema.safeParse(block);
      if (!parsed.success) return "";
      const start = typeof block.start === "number" ? block.start : undefined;
      return renderListItems(
        parsed.data.content,
        blockName(block, PREFIX) === "orderedList",
        start,
        context,
      );
    }
    case "taskList": {
      const parsed = containerSchema.safeParse(block);
      if (!parsed.success) return "";
      return renderTaskItems(parsed.data.content, context);
    }
    case "table":
      return renderTable(block, context);
    case "codeBlock": {
      const code = stringProperty(block, "plaintext");
      return code === undefined
        ? ""
        : codeBlock(code, stringProperty(block, "language"));
    }
    case "hardBreak":
      return voidElement("br");
    case "horizontalRule":
      return voidElement("hr");
    case "image":
      return renderImageAttrs(block.attrs, context);
    case "iframe": {
      const url = stringProperty(block, "url");
      return url ? embedPlaceholder(url, url) : interactivePlaceholder(null);
    }
    case "website":
      if (typeof block.src === "string" && buildPdslsUrl(block.src))
        return recordReferenceCard(block.src, context);
      return linkCard({
        href: stringProperty(block, "src") ?? "",
        title: stringProperty(block, "title"),
        description: stringProperty(block, "description"),
        imageUrl:
          safeSourceUrl(stringProperty(block, "previewImage")) ?? undefined,
      });
    case "blueskyEmbed":
      return blueskyPostCard(block.postRef);
    case "mention": {
      const did = stringProperty(block, "did");
      const href = did ? buildBlueskyProfileUrl(did) : null;
      if (!did || !href) return "";
      const handle = stringProperty(block, "handle") ?? did;
      return paragraph(element("a", { href }, escapeText(`@${handle}`)));
    }
    case "noteEmbed": {
      const ref = strongRefSchema.safeParse(block.noteRef);
      return ref.success ? recordReferenceCard(ref.data.uri, context) : "";
    }
    case "gallery":
      return renderGallery(block, context);
    default:
      return unknownBlock(block, context);
  }
}

export function convertPcktItems(
  items: Block[],
  did: string,
  records?: RecordLookup,
) {
  const context = new ConversionContext(did, records);
  const html = items.map((item) => renderBlock(item, context)).join("");
  return context.finish(html);
}

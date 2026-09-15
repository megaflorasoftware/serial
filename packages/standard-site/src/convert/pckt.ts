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
  blueskyPostCard,
  ConversionContext,
  richTextHeading,
  richTextParagraph,
  stringProperty,
  unknownBlock,
  type Block,
} from "./shared";
import { blobRefSchema } from "../lexicons";
import { buildBlueskyProfileUrl } from "../uris";

const PREFIX = "blog.pckt.block.";

const blockSchema = z.looseObject({ $type: z.string() });

const containerSchema = z.object({ content: z.array(blockSchema) });

const imageAttrsSchema = z.object({
  src: z.string(),
  blob: blobRefSchema.optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
});

const cellSchema = z.object({
  $type: z.string(),
  content: z.array(blockSchema),
  colspan: z.number().optional(),
  rowspan: z.number().optional(),
});

const tableSchema = z.object({
  content: z.array(z.object({ content: z.array(cellSchema) })),
});

export const pcktContentSchema = z.object({
  $type: z.literal("blog.pckt.content"),
  items: z.array(blockSchema).optional(),
  blob: blobRefSchema.optional(),
  references: z.array(blobRefSchema).optional(),
});

export type PcktContent = z.infer<typeof pcktContentSchema>;

/** The blob JSON either is the items array or wraps it as `{ items }`. */
export const pcktBlobSchema = z.union([
  z.array(blockSchema),
  z.object({ items: z.array(blockSchema) }).transform((value) => value.items),
]);

/**
 * Text blocks inside cells and items render inline; anything else keeps its block
 * markup. Callers run this inside `context.nested`.
 */
function renderInline(blocks: Block[], context: ConversionContext) {
  return blocks
    .map((block) => {
      const text = richTextSchema.safeParse(block);
      if (text.success && blockName(block, PREFIX) === "text") {
        return renderRichText(text.data, context);
      }
      return renderBlock(block, context);
    })
    .join("");
}

function renderBlocks(blocks: Block[], context: ConversionContext) {
  return context.nested(() =>
    blocks.map((block) => renderBlock(block, context)).join(""),
  );
}

function renderImageAttrs(value: unknown, context: ConversionContext) {
  const attrs = imageAttrsSchema.safeParse(value);
  if (!attrs.success) return "";
  const { src, blob, alt, title } = attrs.data;
  const cid =
    blob?.ref.$link ?? (src.startsWith("blob:") ? src.slice(5) : null);
  const url = cid ? context.imageUrl(cid) : safeSourceUrl(src);
  if (!url) return "";
  context.noteImage(url);
  // `title` is hover text per the lexicon, not a caption.
  return figure(
    voidElement("img", { src: url, alt: alt ?? "", title }),
    undefined,
  );
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
    value && value > 1 ? String(value) : undefined;
  return context.nested(() => {
    const rows = parsed.data.content.map((row) => {
      const cells = row.content.map((cell) =>
        element(
          blockName(cell, PREFIX) === "tableHeader" ? "th" : "td",
          { colspan: span(cell.colspan), rowspan: span(cell.rowspan) },
          renderInline(cell.content, context),
        ),
      );
      return element("tr", undefined, cells.join(""));
    });
    const body = rows.join("");
    if (!body.replace(/<\/?(?:tr|td|th)[^>]*>/g, "")) return "";
    return element("table", undefined, element("tbody", undefined, body));
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
    case "gallery":
    case "noteEmbed":
      return "";
    default:
      return unknownBlock(block, context);
  }
}

export function convertPcktItems(items: Block[], did: string) {
  const context = new ConversionContext(did);
  const html = items.map((item) => renderBlock(item, context)).join("");
  return context.finish(html);
}

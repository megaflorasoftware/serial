import { z } from "zod";
import { renderRichText, richTextSchema } from "./facets";
import {
  codeBlock,
  element,
  embedPlaceholder,
  escapeText,
  figure,
  image,
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
import { buildBlueskyProfileUrl, isDid } from "../uris";

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

/** Text blocks inside cells and items render inline; anything else keeps its block markup. */
function renderInline(blocks: Block[], context: ConversionContext) {
  return context.nested(() =>
    blocks
      .map((block) => {
        const text = richTextSchema.safeParse(block);
        if (text.success && blockName(block, PREFIX) === "text") {
          return renderRichText(text.data, context);
        }
        return renderBlock(block, context);
      })
      .join(""),
  );
}

function renderBlocks(blocks: Block[], context: ConversionContext) {
  return context.nested(() =>
    blocks.map((block) => renderBlock(block, context)).join(""),
  );
}

function renderImageAttrs(value: unknown, context: ConversionContext) {
  const attrs = imageAttrsSchema.safeParse(value);
  if (!attrs.success) return "";
  let url: string | null = null;
  if (attrs.data.blob) {
    url = context.imageUrl(attrs.data.blob.ref.$link);
  } else if (attrs.data.src.startsWith("blob:")) {
    url = context.imageUrl(attrs.data.src.slice("blob:".length));
  } else {
    url = safeSourceUrl(attrs.data.src);
  }
  if (!url) return "";
  context.noteImage(url);
  return figure(
    image(url, attrs.data.alt),
    attrs.data.title ? escapeText(attrs.data.title) : undefined,
  );
}

function renderListItems(
  blocks: Block[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
) {
  const items = blocks.map((item) => {
    const parsed = containerSchema.safeParse(item);
    return element(
      "li",
      undefined,
      parsed.success ? renderInline(parsed.data.content, context) : "",
    );
  });
  return list(ordered, items, { start });
}

function renderTable(block: Block, context: ConversionContext) {
  const parsed = tableSchema.safeParse(block);
  if (!parsed.success) return "";
  const span = (value: number | undefined) =>
    value && value > 1 ? String(value) : undefined;
  const rows = parsed.data.content.map((row) => {
    const cells = row.content.map((cell) =>
      element(
        cell.$type === `${PREFIX}tableHeader` ? "th" : "td",
        { colspan: span(cell.colspan), rowspan: span(cell.rowspan) },
        renderInline(cell.content, context),
      ),
    );
    return element("tr", undefined, cells.join(""));
  });
  return element(
    "table",
    undefined,
    element("tbody", undefined, rows.join("")),
  );
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
      const inner = renderBlocks(parsed.data.content, context);
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
      const items = parsed.data.content.map((item) => {
        const inner = containerSchema.safeParse(item);
        return taskListItem(
          item.checked === true,
          inner.success ? renderInline(inner.data.content, context) : "",
        );
      });
      return list(false, items, { task: true });
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
      if (!did || !isDid(did)) return "";
      const handle = stringProperty(block, "handle") ?? did;
      return paragraph(
        element(
          "a",
          { href: buildBlueskyProfileUrl(did) },
          escapeText(`@${handle}`),
        ),
      );
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

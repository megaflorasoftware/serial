import { z } from "zod";
import { renderRichText, richTextSchema } from "./facets";
import {
  codeBlock,
  element,
  embedPlaceholder,
  escapeText,
  figure,
  heading,
  image,
  linkCard,
  list,
  paragraph,
  safeSourceUrl,
  taskListItem,
  voidElement,
} from "./html";
import { ConversionContext, textParagraph, unknownBlock } from "./shared";
import { blobRefSchema, strongRefSchema } from "../lexicons";
import { buildBlueskyPostUrl, buildBlueskyProfileUrl } from "../uris";

const PREFIX = "blog.pckt.block.";

const blockSchema = z.object({ $type: z.string() }).passthrough();
type PcktBlock = z.infer<typeof blockSchema>;

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

function renderInline(blocks: PcktBlock[], context: ConversionContext) {
  return blocks
    .map((block) => {
      const text = richTextSchema.safeParse(block);
      if (text.success) return renderRichText(text.data, context);
      return renderBlock(block, context);
    })
    .join("");
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
  blocks: PcktBlock[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
) {
  const items = blocks.map((item) => {
    const parsed = containerSchema.safeParse(item);
    if (!parsed.success) return element("li", undefined, "");
    const inner = parsed.data.content
      .map((child) => {
        const text = richTextSchema.safeParse(child);
        if (text.success && child.$type === `${PREFIX}text`) {
          return renderRichText(text.data, context);
        }
        return renderBlock(child, context);
      })
      .join("");
    return element("li", undefined, inner);
  });
  return list(ordered, items, { start });
}

function renderBlock(block: PcktBlock, context: ConversionContext): string {
  const type = block.$type.startsWith(PREFIX)
    ? block.$type.slice(PREFIX.length)
    : block.$type;
  switch (type) {
    case "text": {
      const text = richTextSchema.safeParse(block);
      return text.success ? textParagraph(text.data, context) : "";
    }
    case "heading": {
      const text = richTextSchema.safeParse(block);
      if (!text.success) return "";
      const level = typeof block.level === "number" ? block.level : 2;
      return heading(level, renderRichText(text.data, context));
    }
    case "blockquote": {
      const parsed = containerSchema.safeParse(block);
      if (!parsed.success) return "";
      const inner = parsed.data.content
        .map((child) => renderBlock(child, context))
        .join("");
      return inner ? element("blockquote", undefined, inner) : "";
    }
    case "bulletList":
    case "orderedList": {
      const parsed = containerSchema.safeParse(block);
      if (!parsed.success) return "";
      const start = typeof block.start === "number" ? block.start : undefined;
      return renderListItems(
        parsed.data.content,
        type === "orderedList",
        start,
        context,
      );
    }
    case "taskList": {
      const parsed = containerSchema.safeParse(block);
      if (!parsed.success) return "";
      const items = parsed.data.content.map((item) => {
        const inner = containerSchema.safeParse(item);
        const checked = (item as { checked?: unknown }).checked === true;
        return taskListItem(
          checked,
          inner.success ? renderInline(inner.data.content, context) : "",
        );
      });
      return list(false, items, { task: true });
    }
    case "table": {
      const parsed = tableSchema.safeParse(block);
      if (!parsed.success) return "";
      const rows = parsed.data.content.map((row) => {
        const cells = row.content.map((cell) => {
          const tag = cell.$type === `${PREFIX}tableHeader` ? "th" : "td";
          return element(
            tag,
            {
              colspan:
                cell.colspan && cell.colspan > 1
                  ? String(cell.colspan)
                  : undefined,
              rowspan:
                cell.rowspan && cell.rowspan > 1
                  ? String(cell.rowspan)
                  : undefined,
            },
            renderInline(cell.content, context),
          );
        });
        return element("tr", undefined, cells.join(""));
      });
      return element(
        "table",
        undefined,
        element("tbody", undefined, rows.join("")),
      );
    }
    case "codeBlock":
      return typeof block.plaintext === "string"
        ? codeBlock(
            block.plaintext,
            typeof block.language === "string" ? block.language : undefined,
          )
        : "";
    case "hardBreak":
      return voidElement("br");
    case "horizontalRule":
      return voidElement("hr");
    case "image":
      return renderImageAttrs(block.attrs, context);
    case "iframe": {
      const url = typeof block.url === "string" ? block.url : undefined;
      return url ? embedPlaceholder(url, url) : "";
    }
    case "website":
      return linkCard({
        href: typeof block.src === "string" ? block.src : "",
        title: typeof block.title === "string" ? block.title : undefined,
        description:
          typeof block.description === "string" ? block.description : undefined,
        imageUrl:
          safeSourceUrl(
            typeof block.previewImage === "string"
              ? block.previewImage
              : undefined,
          ) ?? undefined,
      });
    case "blueskyEmbed": {
      const ref = strongRefSchema.safeParse(block.postRef);
      const href = ref.success ? buildBlueskyPostUrl(ref.data.uri) : null;
      return href ? linkCard({ href, title: "View post on Bluesky" }) : "";
    }
    case "mention": {
      if (typeof block.did !== "string") return "";
      const handle =
        typeof block.handle === "string" ? block.handle : block.did;
      return paragraph(
        element(
          "a",
          { href: buildBlueskyProfileUrl(block.did) },
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

export function convertPcktItems(items: PcktBlock[], did: string) {
  const context = new ConversionContext(did);
  const html = items.map((item) => renderBlock(item, context)).join("");
  return context.finish(html);
}

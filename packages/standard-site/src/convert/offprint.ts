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
  taskListItem,
  voidElement,
} from "./html";
import { ConversionContext, textParagraph, unknownBlock } from "./shared";
import { blobRefSchema, strongRefSchema } from "../lexicons";
import { buildBlueskyPostUrl } from "../uris";

const PREFIX = "app.offprint.block.";

const listItemSchema: z.ZodType<OffprintListItem> = z.lazy(() =>
  z.object({
    content: richTextSchema.optional(),
    checked: z.boolean().optional(),
    children: z.array(listItemSchema).optional(),
  }),
);

type OffprintListItem = {
  content?: z.infer<typeof richTextSchema>;
  checked?: boolean;
  children?: OffprintListItem[];
};

const listSchema = z.object({
  children: z.array(listItemSchema),
  start: z.number().optional(),
});

const imageSchema = z.object({
  image: blobRefSchema.optional(),
  alt: z.string().optional(),
  caption: z.string().optional(),
  captionFacets: richTextSchema.shape.facets,
});

// The lexicon names the grid image blob `blob`; published records use `image`.
const gridImageSchema = z.object({
  blob: blobRefSchema.optional(),
  image: blobRefSchema.optional(),
  alt: z.string().optional(),
});

export const offprintContentSchema = z.object({
  $type: z.literal("app.offprint.content"),
  items: z.array(z.object({ $type: z.string() }).passthrough()),
});

export type OffprintContent = z.infer<typeof offprintContentSchema>;

function renderListItems(
  items: OffprintListItem[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
  task: boolean,
): string {
  const rendered = items.map((item) => {
    const inner = item.content ? renderRichText(item.content, context) : "";
    const nested = item.children?.length
      ? renderListItems(item.children, ordered, undefined, context, task)
      : "";
    if (task) return taskListItem(item.checked === true, inner + nested);
    return element("li", undefined, inner + nested);
  });
  return list(ordered, rendered, { start, task });
}

function renderImage(value: unknown, context: ConversionContext) {
  const parsed = imageSchema.safeParse(value);
  if (!parsed.success || !parsed.data.image) return "";
  const url = context.imageUrl(parsed.data.image.ref.$link);
  context.noteImage(url);
  const caption = parsed.data.caption
    ? renderRichText(
        { plaintext: parsed.data.caption, facets: parsed.data.captionFacets },
        context,
      )
    : undefined;
  return figure(image(url, parsed.data.alt), caption);
}

function renderImageSet(value: unknown, context: ConversionContext) {
  const images = z
    .array(gridImageSchema)
    .safeParse((value as { images?: unknown }).images);
  if (!images.success) return "";
  const caption =
    typeof (value as { caption?: unknown }).caption === "string"
      ? escapeText((value as { caption: string }).caption)
      : undefined;
  const rendered = images.data
    .map((entry) => {
      const blob = entry.blob ?? entry.image;
      if (!blob) return "";
      const url = context.imageUrl(blob.ref.$link);
      context.noteImage(url);
      return image(url, entry.alt);
    })
    .join("");
  return rendered ? figure(rendered, caption) : "";
}

function renderBlock(
  block: Record<string, unknown> & { $type: string },
  context: ConversionContext,
): string {
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
      const items = z
        .array(z.object({ $type: z.string() }).passthrough())
        .safeParse(block.content);
      if (!items.success) return "";
      const inner = items.data
        .map((item) => renderBlock(item, context))
        .join("");
      return inner ? element("blockquote", undefined, inner) : "";
    }
    case "callout": {
      const text = richTextSchema.safeParse(block);
      if (!text.success) return "";
      const emoji =
        typeof block.emoji === "string" && block.emoji
          ? `${escapeText(block.emoji)} `
          : "";
      context.noteParagraph(text.data.plaintext);
      return element(
        "blockquote",
        undefined,
        paragraph(emoji + renderRichText(text.data, context)),
      );
    }
    case "bulletList":
    case "orderedList": {
      const parsed = listSchema.safeParse(block);
      if (!parsed.success) return "";
      return renderListItems(
        parsed.data.children,
        type === "orderedList",
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
    case "codeBlock":
      return typeof block.code === "string"
        ? codeBlock(
            block.code,
            typeof block.language === "string" ? block.language : undefined,
          )
        : "";
    case "mathBlock":
      return typeof block.tex === "string" ? codeBlock(block.tex, "tex") : "";
    case "horizontalRule":
      return voidElement("hr");
    case "image":
      return renderImage(block, context);
    case "imageGrid":
    case "imageCarousel":
    case "imageDiff":
      return renderImageSet(block, context);
    case "webBookmark": {
      const preview = blobRefSchema.safeParse(block.preview);
      return linkCard({
        href: typeof block.href === "string" ? block.href : "",
        title: typeof block.title === "string" ? block.title : undefined,
        description:
          typeof block.description === "string" ? block.description : undefined,
        imageUrl: preview.success
          ? context.imageUrl(preview.data.ref.$link)
          : undefined,
      });
    }
    case "webEmbed":
      return embedPlaceholder(
        typeof block.embedUrl === "string" ? block.embedUrl : undefined,
        typeof block.href === "string" ? block.href : undefined,
      );
    case "button":
      return linkCard({
        href: typeof block.href === "string" ? block.href : "",
        title: typeof block.text === "string" ? block.text : undefined,
        description:
          typeof block.caption === "string" ? block.caption : undefined,
      });
    case "blueskyPost": {
      const ref = strongRefSchema.safeParse(block.post);
      const href = ref.success ? buildBlueskyPostUrl(ref.data.uri) : null;
      return href ? linkCard({ href, title: "View post on Bluesky" }) : "";
    }
    case "component":
      return "";
    default:
      return unknownBlock(block, context);
  }
}

export function convertOffprintContent(content: OffprintContent, did: string) {
  const context = new ConversionContext(did);
  const html = content.items.map((item) => renderBlock(item, context)).join("");
  return context.finish(html);
}

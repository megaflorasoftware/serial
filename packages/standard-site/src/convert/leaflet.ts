import { z } from "zod";
import { renderRichText, richTextSchema } from "./facets";
import {
  codeBlock,
  element,
  embedPlaceholder,
  figure,
  heading,
  image,
  interactivePlaceholder,
  linkCard,
  list,
  paragraph,
  taskListItem,
  voidElement,
} from "./html";
import {
  ConversionContext,
  textParagraph,
  typeName,
  unknownBlock,
} from "./shared";
import { blobRefSchema, strongRefSchema } from "../lexicons";
import { sanitizeArticleHtml } from "../sanitize";
import { buildBlueskyPostUrl, buildPdslsUrl } from "../uris";

const PREFIX = "pub.leaflet.blocks.";

const imageSchema = z.object({
  image: blobRefSchema,
  alt: z.string().optional(),
});

const listItemSchema: z.ZodType<LeafletListItem> = z.lazy(() =>
  z.object({
    content: z.object({ $type: z.string() }).passthrough(),
    checked: z.boolean().optional(),
    children: z.array(listItemSchema).optional(),
    orderedListChildren: z
      .object({
        children: z.array(listItemSchema),
        startIndex: z.number().optional(),
      })
      .optional(),
    unorderedListChildren: z
      .object({ children: z.array(listItemSchema) })
      .optional(),
  }),
);

type LeafletListItem = {
  content: { $type: string } & Record<string, unknown>;
  checked?: boolean;
  children?: LeafletListItem[];
  orderedListChildren?: { children: LeafletListItem[]; startIndex?: number };
  unorderedListChildren?: { children: LeafletListItem[] };
};

const listSchema = z.object({
  children: z.array(listItemSchema),
  startIndex: z.number().optional(),
});

const linearBlockSchema = z.object({
  block: z.object({ $type: z.string() }).passthrough(),
});

const pageSchema = z.object({
  $type: z.string(),
  blocks: z.array(linearBlockSchema).optional(),
});

export const leafletContentSchema = z.object({
  $type: z.literal("pub.leaflet.content"),
  pages: z.array(pageSchema),
});

export type LeafletContent = z.infer<typeof leafletContentSchema>;

const LINEAR_DOCUMENT_TYPE = "pub.leaflet.pages.linearDocument";

function renderListItem(
  item: LeafletListItem,
  context: ConversionContext,
): string {
  const contentType = typeName(item.content) ?? "";
  let inner: string;
  if (contentType === `${PREFIX}image`) {
    inner = renderImage(item.content, context, false);
  } else {
    const text = richTextSchema.safeParse(item.content);
    inner = text.success ? renderRichText(text.data, context) : "";
    if (text.success && contentType === `${PREFIX}header`) {
      inner = element("strong", undefined, inner);
    }
  }

  let nested = "";
  if (item.children && item.children.length > 0) {
    nested = renderList(item.children, false, undefined, context);
  } else if (item.orderedListChildren) {
    nested = renderList(
      item.orderedListChildren.children,
      true,
      item.orderedListChildren.startIndex,
      context,
    );
  } else if (item.unorderedListChildren) {
    nested = renderList(
      item.unorderedListChildren.children,
      false,
      undefined,
      context,
    );
  }

  if (item.checked !== undefined)
    return taskListItem(item.checked, inner + nested);
  return element("li", undefined, inner + nested);
}

function renderList(
  items: LeafletListItem[],
  ordered: boolean,
  start: number | undefined,
  context: ConversionContext,
): string {
  const task = items.some((item) => item.checked !== undefined);
  return list(
    ordered,
    items.map((item) => renderListItem(item, context)),
    { start, task },
  );
}

function renderImage(
  value: unknown,
  context: ConversionContext,
  wrap: boolean,
) {
  const parsed = imageSchema.safeParse(value);
  if (!parsed.success) return "";
  const url = context.imageUrl(parsed.data.image.ref.$link);
  context.noteImage(url);
  const img = image(url, parsed.data.alt);
  return wrap ? figure(img, undefined) : img;
}

function renderHtmlBlock(html: string) {
  const sanitized = sanitizeArticleHtml(html).trim();
  return sanitized || interactivePlaceholder(null);
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
    case "header": {
      const text = richTextSchema.safeParse(block);
      if (!text.success) return "";
      const level = typeof block.level === "number" ? block.level : 2;
      return heading(level, renderRichText(text.data, context));
    }
    case "blockquote": {
      const text = richTextSchema.safeParse(block);
      if (!text.success) return "";
      return element(
        "blockquote",
        undefined,
        paragraph(renderRichText(text.data, context)),
      );
    }
    case "image":
      return renderImage(block, context, true);
    case "imageGallery": {
      const images = z.array(imageSchema).safeParse(block.images);
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
        type === "orderedList",
        parsed.data.startIndex,
        context,
      );
    }
    case "code":
      return typeof block.plaintext === "string"
        ? codeBlock(
            block.plaintext,
            typeof block.language === "string" ? block.language : undefined,
          )
        : "";
    case "math":
      return typeof block.tex === "string" ? codeBlock(block.tex, "tex") : "";
    case "horizontalRule":
      return voidElement("hr");
    case "website": {
      const preview = blobRefSchema.safeParse(block.previewImage);
      return linkCard({
        href: typeof block.src === "string" ? block.src : "",
        title: typeof block.title === "string" ? block.title : undefined,
        description:
          typeof block.description === "string" ? block.description : undefined,
        imageUrl: preview.success
          ? context.imageUrl(preview.data.ref.$link)
          : undefined,
      });
    }
    case "button":
      return linkCard({
        href: typeof block.url === "string" ? block.url : "",
        title: typeof block.text === "string" ? block.text : undefined,
      });
    case "bskyPost": {
      const ref = strongRefSchema.safeParse(block.postRef);
      const href = ref.success ? buildBlueskyPostUrl(ref.data.uri) : null;
      return href ? linkCard({ href, title: "View post on Bluesky" }) : "";
    }
    case "standardSitePost":
    case "standardSitePublication": {
      if (typeof block.uri !== "string") return "";
      return linkCard({
        href: buildPdslsUrl(block.uri),
        title:
          type === "standardSitePost"
            ? "Embedded document"
            : "Embedded publication",
        description: block.uri,
      });
    }
    case "iframe": {
      if (typeof block.html === "string" && block.html.trim()) {
        return renderHtmlBlock(block.html);
      }
      const url = typeof block.url === "string" ? block.url : undefined;
      return url ? embedPlaceholder(url, url) : "";
    }
    case "html":
      return typeof block.html === "string" ? renderHtmlBlock(block.html) : "";
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
export function convertLeafletContent(content: LeafletContent, did: string) {
  const context = new ConversionContext(did);
  let html = "";
  for (const page of content.pages) {
    if (page.$type !== LINEAR_DOCUMENT_TYPE) continue;
    for (const entry of page.blocks ?? []) {
      html += renderBlock(entry.block, context);
    }
  }
  return context.finish(html);
}

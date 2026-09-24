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
  ReaderImage,
  ReaderImageGroupLayout,
  ReaderListItem,
  ReaderTableCell,
} from "./model";
import {
  strongRefSchema,
  blobRefSchema,
  listedRecordSchema,
} from "../lexicons";
import { buildBlueskyProfileUrl, parseAtUri } from "../uris";
import { safeSourceUrl } from "../urls";
import { validEntriesSchema } from "../parse";

const PREFIX = "blog.pckt.block.";

const containerSchema = z.object({ content: blockArraySchema });

const imageAttrsSchema = z.object({
  src: z.string(),
  blob: blobRefSchema.optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  naturalWidth: z.number().optional(),
  naturalHeight: z.number().optional(),
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

const gallerySchema = z.object({
  images: z.array(z.unknown()),
  title: z.string().optional(),
  caption: z.string().optional(),
  layout: z.unknown().optional(),
});

/** pckt defaults to a grid and its masonry is a grid too; `list` is a column. */
function galleryLayout(layout: unknown, count: number): ReaderImageGroupLayout {
  if (layout === "list") return { mode: "stack" };
  if (layout === "carousel") return { mode: "carousel" };
  return naturalGrid(count);
}

/** One image whose blob lives in `did`'s repository: the document's, or a gallery's. */
function readImage(
  value: unknown,
  context: AdapterContext,
  did: string = context.did,
): ReaderImage | null {
  const attrs = imageAttrsSchema.safeParse(value);
  if (!attrs.success) return null;
  const { src, blob, alt, title, naturalWidth, naturalHeight } = attrs.data;
  const cid =
    blob?.ref.$link ?? (src.startsWith("blob:") ? src.slice(5) : null);
  const url = cid ? context.imageUrl(cid, did) : safeSourceUrl(src);
  if (!url) return null;
  const source = value as Block;
  // pckt records the pixel size it measured on upload, not an aspect ratio.
  const measured =
    naturalWidth && naturalHeight
      ? { width: naturalWidth, height: naturalHeight }
      : undefined;
  return image(url, {
    alt,
    title,
    aspectRatio: source.aspectRatio ?? measured,
    width: source.width,
  });
}

/** A gallery block points at a standalone record whose repository owns its image blobs. */
function galleryBlock(
  value: Block,
  context: AdapterContext,
): ReaderBlock | null {
  const uri = recordReferenceUri(stringProperty(value, "ref"));
  const owner = uri ? parseAtUri(uri)?.did : undefined;
  if (!uri || !owner) return null;
  const record = listedRecordSchema.safeParse(context.records(uri));
  const gallery = record.success
    ? gallerySchema.safeParse(record.data.value)
    : null;
  if (!gallery?.success) return notice(value, "unsupported");
  const images = gallery.data.images
    .map((entry) => readImage(entry, context, owner))
    .filter((entry): entry is ReaderImage => entry !== null);
  if (images.length === 0) return notice(value, "unsupported");
  const caption = gallery.data.caption?.trim();
  const title = gallery.data.title?.trim();
  return block(value, {
    kind: "imageGroup",
    images,
    title: title || null,
    caption: caption
      ? [{ kind: "text", text: caption, marks: {}, link: null }]
      : null,
    layout: galleryLayout(gallery.data.layout, images.length),
  });
}

function blocks(items: Block[], context: AdapterContext): ReaderBlock[] {
  return items
    .map((item) => convertBlock(item, context))
    .filter((item): item is ReaderBlock => item !== null);
}

function listItems(entries: Block[], task: boolean, context: AdapterContext) {
  const items: ReaderListItem[] = [];
  for (const entry of entries) {
    const parsed = containerSchema.safeParse(entry);
    if (!parsed.success) continue;
    const content = blocks(parsed.data.content, context);
    if (content.length === 0) continue;
    items.push({ content, checked: task ? entry.checked === true : null });
  }
  return items;
}

function list(
  source: Block,
  entries: Block[],
  ordered: boolean,
  task: boolean,
  context: AdapterContext,
): ReaderBlock | null {
  return context.nested(
    () => {
      const items = listItems(entries, task, context);
      if (items.length === 0) return null;
      const start = source.start;
      return block(source, {
        kind: "list",
        ordered,
        start:
          ordered && typeof start === "number" && Number.isSafeInteger(start)
            ? start
            : null,
        items,
      });
    },
    () => notice(source, "depth"),
  );
}

function table(value: Block, context: AdapterContext): ReaderBlock | null {
  const parsed = tableSchema.safeParse(value);
  if (!parsed.success) return null;
  const span = (raw: number | undefined) =>
    raw !== undefined && Number.isSafeInteger(raw) && raw > 1 ? raw : null;
  return context.nested(
    () => {
      let hasContent = false;
      const rows = parsed.data.content.map((row) =>
        row.content.map((cell): ReaderTableCell => {
          const content = blocks(cell.content, context);
          if (content.length) hasContent = true;
          return {
            header: blockName(cell, PREFIX) === "tableHeader",
            colspan: span(cell.colspan),
            rowspan: span(cell.rowspan),
            content,
          };
        }),
      );
      return hasContent ? block(value, { kind: "table", rows }) : null;
    },
    () => notice(value, "depth"),
  );
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
      const parsed = containerSchema.safeParse(value);
      if (!parsed.success) return null;
      const children = context.nestedBlocks(
        () => blocks(parsed.data.content, context),
        value,
      );
      return children.length
        ? block(value, { kind: "quotation", children })
        : null;
    }
    case "bulletList":
    case "orderedList": {
      const parsed = containerSchema.safeParse(value);
      if (!parsed.success) return null;
      return list(
        value,
        parsed.data.content,
        name === "orderedList",
        false,
        context,
      );
    }
    case "taskList": {
      const parsed = containerSchema.safeParse(value);
      if (!parsed.success) return null;
      return list(value, parsed.data.content, false, true, context);
    }
    case "table":
      return table(value, context);
    case "codeBlock": {
      const code = stringProperty(value, "plaintext");
      return code === undefined
        ? null
        : block(value, {
            kind: "code",
            code,
            language: stringProperty(value, "language") ?? null,
          });
    }
    case "hardBreak":
      return block(value, { kind: "break" });
    case "horizontalRule":
      return block(value, { kind: "divider" });
    case "image": {
      const picture = readImage(value.attrs, context);
      if (!picture) return null;
      const attrs = value.attrs as Block;
      return block(value, {
        kind: "image",
        image: picture,
        caption: null,
        align: readAlign(attrs.align),
      });
    }
    case "iframe":
      return embedBlock(value, {
        href: stringProperty(value, "url"),
        embedUrl: stringProperty(value, "url"),
        height: value.height,
      });
    case "website": {
      const src = stringProperty(value, "src");
      const record = recordReferenceUri(src);
      if (record) return recordPreviewBlock(value, record, context);
      return linkCard(value, {
        href: src,
        title: stringProperty(value, "title"),
        description: stringProperty(value, "description"),
        imageUrl: safeSourceUrl(stringProperty(value, "previewImage")),
      });
    }
    case "blueskyEmbed":
      return blueskyPostBlock(value, value.postRef, context);
    case "mention": {
      const did = stringProperty(value, "did");
      const href = did ? buildBlueskyProfileUrl(did) : null;
      if (!did || !href) return null;
      const handle = stringProperty(value, "handle") ?? did;
      return block(value, {
        kind: "paragraph",
        content: [
          {
            kind: "text",
            text: `@${handle}`,
            marks: {},
            link: { href, record: null },
          },
        ],
      });
    }
    case "noteEmbed": {
      const ref = strongRefSchema.safeParse(value.noteRef);
      return ref.success
        ? recordPreviewBlock(value, ref.data.uri, context)
        : null;
    }
    case "gallery":
      return galleryBlock(value, context);
    default:
      return unknownBlock(value, context);
  }
}

export function derivePcktItems(
  items: Block[],
  context: AdapterContext,
): ReaderBlock[] {
  return blocks(items, context);
}

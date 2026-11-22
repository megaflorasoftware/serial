import Parser from "rss-parser";
import { z } from "zod";
import { MAX_ITEM_CONTENT_BYTES, truncateUtf8 } from "./feedBounds";
import { computeItemHash } from "./hash";
import type { LegacyItemInputs, RSSContent } from "./types";

/**
 * Items stored before Feed origins existed carry a hash of what the previous
 * website parser read from the feed. That parser kept whitespace, authors and
 * thumbnails differently from the current one, so its hash cannot be rebuilt
 * from a parsed item alone. The previous parser's reading therefore travels
 * beside each item, small enough to cache, and such an item is recognised as
 * unchanged without reading or rewriting it.
 */
const previousParser = new Parser({
  customFields: {
    item: [
      "description",
      ["media:content", "mediaContent"],
      ["media:thumbnail", "mediaThumbnail"],
      "enclosure",
    ],
  },
});

const mediaSchema = z
  .object({
    $: z.object({
      url: z.string().optional(),
      medium: z.string().optional(),
      type: z.string().optional(),
    }),
  })
  .optional();

const previousItemSchema = z.object({
  creator: z.string().optional(),
  title: z.string(),
  link: z.string(),
  pubDate: z.string().optional(),
  "content:encoded": z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  isoDate: z.string().optional(),
  updated: z.string().optional(),
  guid: z.string().optional(),
  id: z.string().optional(),
  mediaContent: mediaSchema,
  mediaThumbnail: mediaSchema,
  enclosure: z
    .object({ url: z.string().optional(), type: z.string().optional() })
    .optional(),
});
type PreviousItem = z.infer<typeof previousItemSchema>;

export const legacyItemInputsSchema = z.object({
  title: z.string(),
  author: z.string(),
  publishedDate: z.string(),
  thumbnail: z.string().optional(),
  content: z.union([
    z.object({ lead: z.string(), trail: z.string() }),
    z.object({ text: z.string() }),
  ]),
}) satisfies z.ZodType<LegacyItemInputs>;

/** How much of the previous body may be carried when it is not the current body plus whitespace. */
const MAX_CARRIED_BODY_CHARACTERS = 1024;
const MAX_AFFIX_CHARACTERS = 256;

function longest(...values: Array<string | undefined>) {
  return values.reduce<string>(
    (found, value) => (value && value.length > found.length ? value : found),
    "",
  );
}

/** The thumbnail the previous parser took from the feed, before any page lookup. */
function previousFeedThumbnail(item: PreviousItem) {
  if (item.mediaThumbnail?.$.url) return item.mediaThumbnail.$.url;
  const media = item.mediaContent?.$;
  if (
    media?.url &&
    ((media.type ?? "").startsWith("image/") || media.medium === "image")
  )
    return media.url;
  if (item.enclosure?.url && item.enclosure.type?.startsWith("image/"))
    return item.enclosure.url;
  const html = item["content:encoded"] || item.content || item.description;
  return html?.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
}

/**
 * The previous body as affixes around the current one, or whole when short.
 * Both ingests bound a body, and the previous one hashed what was left. Where
 * the bound cuts inside the current body the trail was never hashed, so it is
 * not carried: the bounded current body would otherwise end short of the cut
 * and let the trail back in.
 */
function carriedBody(
  previous: string,
  current: string,
): LegacyItemInputs["content"] | undefined {
  const start = current ? previous.indexOf(current) : -1;
  if (start >= 0 && previous.length - current.length <= MAX_AFFIX_CHARACTERS) {
    const lead = previous.slice(0, start);
    const cutInsideCurrent =
      Buffer.byteLength(lead + current) >= MAX_ITEM_CONTENT_BYTES;
    return {
      lead,
      trail: cutInsideCurrent ? "" : previous.slice(start + current.length),
    };
  }
  return previous.length <= MAX_CARRIED_BODY_CHARACTERS
    ? { text: previous }
    : undefined;
}

async function previousItemsById(feedText: string) {
  try {
    const parsed = await previousParser.parseString(feedText);
    const items = z.array(previousItemSchema).safeParse(parsed.items);
    return new Map(
      (items.data ?? []).flatMap((item) => {
        const id = item.guid || item.id;
        return id ? [[id, item] as const] : [];
      }),
    );
  } catch {
    // A document the previous parser could not read left no items behind.
    return new Map<string, PreviousItem>();
  }
}

/** Attaches the previous parser's reading to each item it also read. */
export async function withLegacyInputs(
  feedText: string,
  items: RSSContent[],
): Promise<RSSContent[]> {
  const previous = await previousItemsById(feedText);
  return items.map((item) => {
    const before = previous.get(item.id);
    const content =
      before &&
      carriedBody(
        longest(before["content:encoded"], before.content, before.description),
        item.content ?? "",
      );
    if (!before || !content) return item;
    const thumbnail = previousFeedThumbnail(before);
    return {
      ...item,
      legacy: {
        title: before.title,
        author: before.creator ?? "",
        publishedDate: before.pubDate || before.isoDate || before.updated || "",
        ...(thumbnail === undefined ? {} : { thumbnail }),
        content,
      },
    };
  });
}

/**
 * The content hash the previous ingest stored for this item. Its thumbnail
 * came from the feed when the feed had one and from a page lookup otherwise;
 * the stored thumbnail stands in for that lookup, which is not repeated.
 */
export function legacyItemHash(item: RSSContent, storedThumbnail: string) {
  const { legacy } = item;
  if (!legacy) return null;
  return computeItemHash({
    contentId: item.id,
    title: legacy.title,
    author: legacy.author,
    // The previous ingest bounded the body before hashing it.
    content: truncateUtf8(
      "text" in legacy.content
        ? legacy.content.text
        : legacy.content.lead + (item.content ?? "") + legacy.content.trail,
      MAX_ITEM_CONTENT_BYTES,
    ),
    thumbnail: legacy.thumbnail ?? storedThumbnail,
    postedAt: new Date(legacy.publishedDate),
  });
}

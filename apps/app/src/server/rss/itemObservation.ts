import { sanitizeEmbeddedContent } from "@serial/standard-site";
import { boundFeedItems } from "./feedBounds";
import type { DatabaseFeedItem } from "../db/schema";
import type { RSSContent } from "./types";
import type { ItemObservation } from "../db/feed-item-observation";
import { normalizeBookmarkUrl } from "~/server/bookmarks/url";

export type { ItemObservation } from "../db/feed-item-observation";

export function itemUrl(value: string) {
  return value.startsWith("at://") ? value : normalizeBookmarkUrl(value);
}

export function rssObservation(item: RSSContent): ItemObservation {
  const bounded = boundFeedItems([item])[0]!;
  const body = sanitizeEmbeddedContent(bounded.content ?? "");
  return {
    kind: "rss",
    key: item.id,
    url: itemUrl(item.url),
    title: item.title,
    author: item.author,
    description: bounded.contentSnippet ?? "",
    thumbnail:
      item.mediaThumbnail ??
      (item.firstImageUrl === undefined ? item.thumbnail : "") ??
      "",
    content: body.html,
    firstParagraph: body.firstParagraph ?? "",
    firstImageUrl:
      body.firstImageUrl ?? item.firstImageUrl ?? item.thumbnail ?? "",
    publishedAt: item.publishedDate,
    tags: item.tags ?? [],
  };
}

export function composeItem(
  rss: ItemObservation | undefined,
  document: ItemObservation | undefined,
  pageImage?: string | null,
) {
  const primary = document ?? rss!;
  const body = document?.content ? document : rss?.content ? rss : undefined;
  return {
    contentId: primary.key,
    url: document?.url.startsWith("at://")
      ? (rss?.url ?? document.url)
      : primary.url,
    title: document?.title || rss?.title || "",
    author: document?.author || rss?.author || document?.publicationName || "",
    contentSnippet:
      document?.description || rss?.description || body?.firstParagraph || "",
    thumbnail:
      document?.thumbnail ||
      rss?.thumbnail ||
      pageImage ||
      body?.firstImageUrl ||
      "",
    content: body?.content ?? "",
    postedAt: new Date(document?.publishedAt || rss?.publishedAt || 0),
    sourceKind: document && rss ? ("both" as const) : primary.kind,
    bodySource: body?.kind ?? ("none" as const),
    atprotoUri: document?.key ?? null,
    tags: [
      ...new Set([...(document?.tags ?? []), ...(rss?.tags ?? [])]),
    ].sort(),
  };
}

export function legacyObservation(item: DatabaseFeedItem) {
  return rssObservation({
    id: item.contentId,
    url: item.url,
    title: item.title,
    author: item.author,
    content: item.content,
    contentSnippet: item.contentSnippet,
    thumbnail: item.thumbnail,
    // Old rows did not distinguish a body fallback from explicit feed media.
    ...(item.content.includes(item.thumbnail) && item.thumbnail
      ? { mediaThumbnail: "", firstImageUrl: item.thumbnail }
      : {}),
    publishedDate: item.postedAt.toISOString(),
    tags: item.tags,
  });
}

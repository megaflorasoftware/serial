import { createHash } from "node:crypto";
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

/** One hash for a set of stated fields, whatever order they are given in; absent fields do not count. */
function digestOf(stated: Record<string, unknown>) {
  const canonical = Object.entries(stated)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Identifies an observation as its source stated it. The page image comes from
 * a later lookup, not from the source, so it stays out: an observation whose
 * source did not change keeps its digest whether or not the lookup has run.
 */
export function observationDigest(observation: ItemObservation) {
  return digestOf({ ...observation, pageImageUrl: undefined });
}

/**
 * Bump to derive every RSS observation again on its next fetch, after a change
 * to how `rssObservation` reads an item that stored observations should follow.
 */
const RSS_DERIVATION = 1;

/**
 * Identifies an RSS observation by the parsed item it derives from, so an
 * unchanged item is recognised before its body is sanitized. Covers exactly
 * what `rssObservation` reads.
 */
export function rssItemDigest(item: RSSContent) {
  return digestOf({
    derivation: RSS_DERIVATION,
    id: item.id,
    url: item.url,
    title: item.title,
    author: item.author,
    content: item.content,
    contentSnippet: item.contentSnippet,
    thumbnail: item.thumbnail,
    mediaThumbnail: item.mediaThumbnail,
    firstImageUrl: item.firstImageUrl,
    publishedDate: item.publishedDate,
    tags: item.tags,
  });
}

export function composeItem(
  rss: ItemObservation | undefined,
  document: ItemObservation | undefined,
) {
  const primary = document ?? rss!;
  const body =
    document?.content || document?.sourceCid
      ? document
      : rss?.content
        ? rss
        : undefined;
  const url = document?.url.startsWith("at://")
    ? (rss?.url ?? document.url)
    : primary.url;
  return {
    contentId: primary.key,
    url,
    title: document?.title || rss?.title || "",
    author: document?.author || rss?.author || document?.publicationName || "",
    contentSnippet:
      document?.description || rss?.description || body?.firstParagraph || "",
    thumbnail:
      document?.thumbnail ||
      rss?.thumbnail ||
      document?.pageImageUrl ||
      (rss?.url === url ? rss.pageImageUrl : undefined) ||
      body?.firstImageUrl ||
      "",
    content: body?.content ?? "",
    sourceCid: body?.sourceCid ?? null,
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
    publishedDate: item.postedAt.toISOString(),
    tags: item.tags,
  });
}

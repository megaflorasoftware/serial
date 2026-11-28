import { parseFeed } from "feedsmith";
import { decodeHTML } from "entities";
import { httpUrl } from "@serial/feed-discovery";
import type { Atom, DeepPartial } from "feedsmith/types";
import type { FeedFetchMetadata, RSSContent } from "./types";

/** A body that no syndication format reads. Sites serve these; it is not a fault of ours. */
export class FeedParseError extends Error {}

/**
 * feedsmith and its XML parser reject input only with plain Errors. Any other
 * kind, such as a TypeError, is a fault in the code and stays unexpected.
 */
function rejectsInput(error: unknown): error is Error {
  return error instanceof Error && error.constructor === Error;
}

function parseDocument(text: string) {
  try {
    return parseFeed(text);
  } catch (error) {
    if (!rejectsInput(error)) throw error;
    throw new FeedParseError(error.message, { cause: error });
  }
}

export type SyndicationFeed = {
  format: "atom" | "json" | "rss" | "rdf";
  title: string;
  siteUrl?: string;
  description?: string;
  imageUrl?: string;
  items: RSSContent[];
  hasFullBody: boolean;
  fetchMetadata: FeedFetchMetadata;
};

function updatePeriod(
  value: string | undefined,
): FeedFetchMetadata["updatePeriod"] {
  return value === "hourly" ||
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "yearly"
    ? value
    : undefined;
}

function absoluteUrl(value: string | undefined, base: string) {
  if (!value) return undefined;
  try {
    return httpUrl(new URL(value, base).toString()) ?? undefined;
  } catch {
    return undefined;
  }
}

function plainTextHtml(value: string | undefined) {
  return value
    ?.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function firstImage(content: string | undefined, base: string) {
  return absoluteUrl(
    content?.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1],
    base,
  );
}

function mediaImage(media: DeepPartial<Atom.Entry<string>>["media"]) {
  return (
    media?.thumbnails?.[0]?.url ??
    media?.contents?.find(
      (entry) => entry.medium === "image" || entry.type?.startsWith("image/"),
    )?.url
  );
}

function contentSnippet(content: string | undefined) {
  if (content === undefined) return undefined;
  return decodeHTML(
    content
      .replace(
        /<\/?(?:h[1-6]|br|p|ul|ol|li|blockquote|section|table|tr|div)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]*>/g, ""),
  ).trim();
}

/** One parser for discovery ranking and website ingestion, including JSON Feed. */
export function parseSyndicationFeed(
  text: string,
  url: string,
): SyndicationFeed {
  const parsed = parseDocument(text);
  const items: RSSContent[] = [];
  let hasFullBody = false;
  if (parsed.format === "atom") {
    const feed = parsed.feed;
    const siteUrl = absoluteUrl(
      feed.links?.find((link) => !link.rel || link.rel === "alternate")?.href,
      url,
    );
    for (const item of feed.entries ?? []) {
      const link = absoluteUrl(
        item.links?.find((link) => !link.rel || link.rel === "alternate")?.href,
        siteUrl ?? url,
      );
      if (!item.id || !link) continue;
      const content = item.content || item.summary;
      hasFullBody ||= Boolean(item.content);
      const enclosure = item.links?.find(
        (link) => link.rel === "enclosure" && link.type?.startsWith("image/"),
      );
      const mediaThumbnail = absoluteUrl(
        mediaImage(item.media) ?? enclosure?.href,
        link,
      );
      const firstImageUrl = firstImage(content, link);
      items.push({
        id: item.id,
        url: link,
        title: item.title ?? "",
        author: (item.authors ?? item.source?.authors ?? feed.authors ?? [])
          .flatMap((author) => (author.name ? [author.name] : []))
          .join(", "),
        publishedDate: item.published ?? item.updated ?? "",
        updatedDate: item.updated,
        tags: (item.categories ?? []).flatMap((category) =>
          category.term ? [category.term] : [],
        ),
        content,
        contentSnippet: contentSnippet(item.summary ?? content),
        thumbnail: mediaThumbnail ?? firstImageUrl,
        mediaThumbnail: mediaThumbnail ?? "",
        firstImageUrl: firstImageUrl ?? "",
      });
    }
    return {
      format: "atom",
      title: feed.title ?? "",
      siteUrl,
      description: feed.subtitle,
      imageUrl: absoluteUrl(feed.icon ?? feed.logo, siteUrl ?? url),
      items,
      hasFullBody,
      fetchMetadata: {
        updatePeriod: updatePeriod(feed.sy?.updatePeriod),
        updateFrequency: feed.sy?.updateFrequency,
      },
    };
  }
  if (parsed.format === "json") {
    const feed = parsed.feed;
    for (const item of feed.items ?? []) {
      const link = absoluteUrl(
        item.url ?? item.external_url,
        feed.home_page_url ?? url,
      );
      if (!item.id || !link) continue;
      const content = item.content_html || plainTextHtml(item.content_text);
      hasFullBody ||= Boolean(content);
      const mediaThumbnail = absoluteUrl(
        item.image ??
          item.banner_image ??
          item.attachments?.find((attachment) =>
            attachment.mime_type?.startsWith("image/"),
          )?.url,
        link,
      );
      const firstImageUrl = firstImage(content, link);
      items.push({
        id: item.id,
        url: link,
        title: item.title ?? "",
        author: (item.authors ?? feed.authors ?? [])
          .flatMap((author) => (author.name ? [author.name] : []))
          .join(", "),
        publishedDate: item.date_published ?? item.date_modified ?? "",
        updatedDate: item.date_modified,
        tags: item.tags ?? [],
        content,
        contentSnippet:
          item.summary ?? item.content_text ?? contentSnippet(content),
        thumbnail: mediaThumbnail ?? firstImageUrl,
        mediaThumbnail: mediaThumbnail ?? "",
        firstImageUrl: firstImageUrl ?? "",
      });
    }
    return {
      format: "json",
      title: feed.title ?? "",
      siteUrl: absoluteUrl(feed.home_page_url, url),
      description: feed.description,
      imageUrl: absoluteUrl(feed.icon ?? feed.favicon, url),
      items,
      hasFullBody,
      fetchMetadata: {},
    };
  }
  const feed = parsed.feed;
  for (const item of feed.items ?? []) {
    const link = absoluteUrl(item.link, feed.link ?? url);
    const id = "guid" in item ? (item.guid?.value ?? link) : link;
    if (!id || !link) continue;
    const body = item.content?.encoded;
    const content = [body, item.description].reduce<string>(
      (longest, value) =>
        value && value.length > longest.length ? value : longest,
      "",
    );
    hasFullBody ||= Boolean(body);
    const enclosure =
      "enclosures" in item
        ? item.enclosures?.find((entry) => entry.type?.startsWith("image/"))
        : undefined;
    const mediaThumbnail = absoluteUrl(
      mediaImage(item.media) ?? enclosure?.url,
      link,
    );
    const firstImageUrl = firstImage(content, link);
    items.push({
      id,
      url: link,
      title: item.title ?? "",
      author:
        item.dc?.creator ??
        item.dc?.creators?.join(", ") ??
        ("authors" in item ? item.authors?.join(", ") : undefined) ??
        "",
      publishedDate:
        ("pubDate" in item ? item.pubDate : undefined) ?? item.dc?.date ?? "",
      tags:
        "categories" in item
          ? item.categories?.flatMap((category) =>
              category.name ? [category.name] : [],
            )
          : [],
      content,
      contentSnippet: contentSnippet(item.description ?? content),
      thumbnail: mediaThumbnail ?? firstImageUrl,
      mediaThumbnail: mediaThumbnail ?? "",
      firstImageUrl: firstImageUrl ?? "",
    });
  }
  return {
    format: parsed.format,
    title: feed.title ?? "",
    siteUrl: absoluteUrl(feed.link, url),
    description: feed.description,
    imageUrl: absoluteUrl(
      typeof feed.image === "object" ? feed.image?.url : undefined,
      url,
    ),
    items,
    hasFullBody,
    fetchMetadata: {
      ttl: "ttl" in feed ? feed.ttl : undefined,
      updatePeriod: updatePeriod(feed.sy?.updatePeriod),
      updateFrequency: feed.sy?.updateFrequency,
    },
  };
}

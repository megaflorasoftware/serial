import { parseFeed } from "feedsmith";
import { decodeHTML } from "entities";
import { httpUrl } from "@serial/feed-discovery";
import type { FeedFetchMetadata, RSSContent } from "./types";

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
  const parsed = parseFeed(text);
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
        thumbnail:
          absoluteUrl(enclosure?.href, link) ?? firstImage(content, link),
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
        thumbnail:
          absoluteUrl(
            item.image ??
              item.banner_image ??
              item.attachments?.find((attachment) =>
                attachment.mime_type?.startsWith("image/"),
              )?.url,
            link,
          ) ?? firstImage(content, link),
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
      thumbnail:
        absoluteUrl(
          item.media?.thumbnails?.[0]?.url ??
            item.media?.contents?.find(
              (entry) =>
                entry.medium === "image" || entry.type?.startsWith("image/"),
            )?.url ??
            enclosure?.url,
          link,
        ) ?? firstImage(content, link),
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

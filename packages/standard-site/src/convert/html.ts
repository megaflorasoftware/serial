/**
 * Minimal HTML emission helpers. Output must round-trip through
 * `sanitizeArticleHtml` unchanged, so text is escaped the way hast-util-to-html
 * serialises it: `&` and `<` in text; `&`, `"`, `'`, and a backtick in attribute
 * values; nothing else. The parser drops U+0000 from text and turns it into
 * U+FFFD in attributes, so it is removed before either. CR and CRLF become LF.
 */

function normalizeHtmlText(value: string) {
  return value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
}

export function escapeText(value: string) {
  return normalizeHtmlText(value)
    .replace(/&/g, "&#x26;")
    .replace(/</g, "&#x3C;");
}

export function escapeAttribute(value: string) {
  return normalizeHtmlText(value)
    .replace(/&/g, "&#x26;")
    .replace(/"/g, "&#x22;")
    .replace(/'/g, "&#x27;")
    .replace(/`/g, "&#x60;");
}

export type Attributes = Record<string, string | true | undefined>;

function renderAttributes(attributes: Attributes | undefined) {
  if (!attributes) return "";
  let rendered = "";
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    rendered +=
      value === true ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`;
  }
  return rendered;
}

export function openTag(tag: string, attributes?: Attributes) {
  return `<${tag}${renderAttributes(attributes)}>`;
}

export function closeTag(tag: string) {
  return `</${tag}>`;
}

export function element(
  tag: string,
  attributes: Attributes | undefined,
  children: string,
) {
  return openTag(tag, attributes) + children + closeTag(tag);
}

export function voidElement(tag: string, attributes?: Attributes) {
  return openTag(tag, attributes);
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_SOURCE_PROTOCOLS = new Set(["http:", "https:"]);

function safeUrl(value: string | undefined, protocols: Set<string>) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!protocols.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function safeLinkUrl(value: string | undefined) {
  return safeUrl(value, SAFE_LINK_PROTOCOLS);
}

export function safeSourceUrl(value: string | undefined) {
  return safeUrl(value, SAFE_SOURCE_PROTOCOLS);
}

export function anchor(href: string, children: string) {
  return element("a", { href }, children);
}

export function paragraph(children: string) {
  return element("p", undefined, children);
}

export function heading(level: number, children: string) {
  const clamped = Math.min(6, Math.max(1, Math.round(level)));
  return element(`h${clamped}`, undefined, children);
}

export function image(src: string, alt: string | undefined) {
  return voidElement("img", { src, alt: alt ?? "" });
}

export function figure(imageHtml: string, caption: string | undefined) {
  if (!caption) return element("figure", undefined, imageHtml);
  return element(
    "figure",
    undefined,
    imageHtml + element("figcaption", undefined, caption),
  );
}

export function codeBlock(code: string, language: string | undefined) {
  // The sanitizer keeps `class` on code only when it names a language.
  const slug = language?.replace(/[^\w+#.-]/g, "") ?? "";
  const className = slug ? `language-${slug}` : undefined;
  return element(
    "pre",
    undefined,
    element("code", { class: className }, escapeText(code)),
  );
}

export function taskListItem(checked: boolean, children: string) {
  const checkbox = voidElement("input", {
    type: "checkbox",
    disabled: true,
    checked: checked || undefined,
  });
  return element("li", { class: "task-list-item" }, `${checkbox} ${children}`);
}

export function list(
  ordered: boolean,
  items: string[],
  options: { start?: number; task?: boolean } = {},
) {
  if (items.length === 0) return "";
  const attributes: Attributes = {};
  const start = options.start;
  if (
    ordered &&
    start !== undefined &&
    Number.isSafeInteger(start) &&
    start !== 1
  ) {
    attributes.start = String(start);
  }
  if (options.task) attributes.class = "contains-task-list";
  return element(ordered ? "ol" : "ul", attributes, items.join(""));
}

export type LinkCardInput = {
  href: string;
  title?: string;
  description?: string;
  imageUrl?: string;
};

/**
 * Websites, bookmarks, buttons, and post embeds all become one link card: a
 * paragraph with a strong title link, an optional description, and an optional
 * preview image before it.
 */
export function linkCard(input: LinkCardInput) {
  const href = safeLinkUrl(input.href);
  if (!href) return "";
  const title = escapeText(input.title?.trim() || input.href);
  const description = input.description?.trim();
  let body = anchor(href, element("strong", undefined, title));
  if (description) body += voidElement("br") + escapeText(description);
  const preview = input.imageUrl
    ? anchor(href, image(input.imageUrl, input.title))
    : "";
  return preview + paragraph(body);
}

export const INTERACTIVE_PLACEHOLDER_TEXT =
  "Interactive content available on original site";

export function youtubePlaceholder(videoId: string, start: string | null) {
  return element(
    "div",
    {
      "data-serial-embed": "youtube",
      "data-video-id": videoId,
      "data-start": start ?? undefined,
    },
    paragraph(
      anchor(`https://www.youtube.com/watch?v=${videoId}`, "Watch on YouTube"),
    ),
  );
}

export function interactivePlaceholder(href: string | null) {
  const safeHref = href ? safeLinkUrl(href) : null;
  const text = escapeText(INTERACTIVE_PLACEHOLDER_TEXT);
  return element(
    "div",
    { "data-serial-embed": "interactive", "data-href": safeHref ?? undefined },
    paragraph(safeHref ? anchor(safeHref, text) : text),
  );
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
]);
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export type YouTubeReference = { videoId: string; start: string | null };

export function parseYouTubeReference(
  url: string | undefined,
): YouTubeReference | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;

  let videoId: string | null = null;
  if (parsed.hostname === "youtu.be") {
    videoId = parsed.pathname.slice(1).split("/")[0] ?? null;
  } else {
    const embedMatch = /^\/(?:embed|shorts|live|v)\/([^/]+)/.exec(
      parsed.pathname,
    );
    videoId = embedMatch?.[1] ?? parsed.searchParams.get("v");
  }
  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) return null;

  const start =
    parsed.searchParams.get("start") ?? parsed.searchParams.get("t");
  // Share links write the offset as `t=30s`; embeds write `start=30`.
  const validStart = start ? /^(\d+)s?$/.exec(start)?.[1] : undefined;
  return { videoId, start: validStart ?? null };
}

/**
 * Every iframe or web embed becomes an inert placeholder: the YouTube one when
 * either URL names a video, otherwise the interactive one linking to the source.
 */
export function embedPlaceholder(
  embedUrl: string | undefined,
  href: string | undefined,
) {
  const youtube =
    parseYouTubeReference(embedUrl) ?? parseYouTubeReference(href);
  if (youtube) return youtubePlaceholder(youtube.videoId, youtube.start);
  return interactivePlaceholder(href ?? embedUrl ?? null);
}

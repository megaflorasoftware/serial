export const BOOKMARK_CAPTURE_LIMITS = {
  extensionRequestBytes: 4 * 1024 * 1024,
  storedHtmlBytes: 2 * 1024 * 1024,
  fetchedHtmlBytes: 5 * 1024 * 1024,
  domElements: 50_000,
  redirects: 5,
  responseHeadersMs: 5_000,
  totalAttemptMs: 15_000,
  urlBytes: 8 * 1024,
  titleCodePoints: 1_024,
  authorCodePoints: 512,
  descriptionCodePoints: 2_048,
  siteNameCodePoints: 512,
  versionBytes: 128,
  discoveredFeeds: 16,
} as const;

export const EXTENSION_INSTANCE_REQUEST_TIMEOUT_MS = 10_000;
export const FEED_HTTP_REQUEST_TIMEOUT_MS = 15_000;
export const FEED_HTTP_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const FEED_ADD_MAX_DISCOVERED_FEEDS = 8;
export const FEED_INGESTION_CONCURRENCY = 8;
const FEED_ADD_FETCH_WAVES = Math.ceil(
  FEED_ADD_MAX_DISCOVERED_FEEDS / FEED_INGESTION_CONCURRENCY,
);
// Worst case: one channel-discovery fetch, bounded detail-fetch waves, bounded
// initial-ingestion waves, and a small allowance for parsing/database writes.
export const EXTENSION_FEED_ADD_REQUEST_TIMEOUT_MS =
  FEED_HTTP_REQUEST_TIMEOUT_MS * (1 + FEED_ADD_FETCH_WAVES * 2) + 10_000;

/**
 * Version 2 retains `<iframe src height>` as External content. Version 1
 * replaced YouTube frames with a `data-serial-embed` placeholder; the server
 * still accepts version 1 captures and the placeholder attributes stay in the
 * allowlist so those captures survive re-sanitization until the sunset.
 */
export const SANITIZER_POLICY_VERSION = 2;
export const ACCEPTED_SANITIZER_POLICY_VERSIONS: readonly number[] = [1, 2];
export const EXTENSION_BOOKMARK_CONTRACT_VERSION = 2;
export const READABILITY_EXTRACTOR_VERSION = "mozilla-readability-0.6";

export const BOOKMARK_CAPTURE_ALLOWED_TAGS = [
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "iframe",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
] as const;

export const BOOKMARK_CAPTURE_ALLOWED_ATTRIBUTES = [
  "alt",
  "aria-label",
  "colspan",
  "datetime",
  "dir",
  "height",
  "href",
  "id",
  "lang",
  "open",
  "role",
  "rowspan",
  "scope",
  "src",
  "srcset",
  "title",
  "width",
  // Version 1 placeholder attributes; see SANITIZER_POLICY_VERSION.
  "data-serial-embed",
  "data-video-id",
  "data-start",
] as const;

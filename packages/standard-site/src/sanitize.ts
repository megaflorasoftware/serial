import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { Options as SanitizeSchema } from "rehype-sanitize";

export const SERIAL_EMBED_KINDS = ["youtube", "interactive"] as const;
export type SerialEmbedKind = (typeof SERIAL_EMBED_KINDS)[number];

/**
 * The schema every stored article body is a fixed point of. It extends the
 * rehype-sanitize default (which the reader's simplified mode already applies) with
 * underline, highlight, figures, and the inert placeholder attributes that stand in
 * for embedded content.
 *
 * Contract for callers: converted bodies are already fixed points, so
 * `sanitizeArticleHtml` is a no-op guard on them. Bodies from any other source
 * (RSS, author HTML) must go through `sanitizeEmbeddedHtml` once at ingest; the
 * article schema prefixes `id` and `name` on every pass and is therefore not
 * idempotent on markup that carries them.
 */
export const ARTICLE_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "u",
    "mark",
    "figure",
    "figcaption",
  ],
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ["dataSerialEmbed", ...SERIAL_EMBED_KINDS],
      "dataVideoId",
      "dataStart",
      "dataHref",
    ],
  },
};

const CLOBBERED_ATTRIBUTES = new Set(defaultSchema.clobber ?? []);

/**
 * The article schema minus the attributes rehype prefixes against DOM clobbering
 * (`id`, `name`, and the aria references). Prefixing is applied on every pass, so
 * markup carrying those attributes can never be a sanitizer fixed point; author
 * HTML embedded in a document is sanitized with this schema instead, and converted
 * bodies therefore never contain them.
 */
export const EMBEDDED_HTML_SANITIZE_SCHEMA: SanitizeSchema = {
  ...ARTICLE_SANITIZE_SCHEMA,
  attributes: Object.fromEntries(
    Object.entries(ARTICLE_SANITIZE_SCHEMA.attributes ?? {}).map(
      ([tag, attributes]) => [
        tag,
        attributes.filter((attribute) => {
          const name = Array.isArray(attribute) ? attribute[0] : attribute;
          return !CLOBBERED_ATTRIBUTES.has(name);
        }),
      ],
    ),
  ),
};

function buildProcessor(schema: SanitizeSchema) {
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, schema)
    .use(rehypeStringify);
}

const articleProcessor = buildProcessor(ARTICLE_SANITIZE_SCHEMA);
const embeddedProcessor = buildProcessor(EMBEDDED_HTML_SANITIZE_SCHEMA);

export function sanitizeArticleHtml(html: string) {
  return String(articleProcessor.processSync(html));
}

export function sanitizeEmbeddedHtml(html: string) {
  return String(embeddedProcessor.processSync(html));
}

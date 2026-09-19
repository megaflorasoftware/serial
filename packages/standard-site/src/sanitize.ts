import { RECORD_CARD_FIELDS, RECORD_CARD_SIZES } from "./record-card";
import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import { safeSourceUrl } from "./convert/html";

export const SERIAL_EMBED_KINDS = ["youtube", "interactive", "record"] as const;
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
    a: [...(defaultSchema.attributes?.a ?? []), "dataRecordUri"],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ["dataSerialEmbed", ...SERIAL_EMBED_KINDS],
      "dataVideoId",
      "dataStart",
      ...Object.values(RECORD_CARD_FIELDS)
        .filter((attribute) => attribute !== "data-size")
        .map((attribute) =>
          attribute.replace(/-([a-z])/g, (_, letter: string) =>
            letter.toUpperCase(),
          ),
        ),
      ["dataSize", ...RECORD_CARD_SIZES],
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

type HtmlTree = ReturnType<typeof embeddedProcessor.parse>;
type HtmlNode = HtmlTree | HtmlTree["children"][number];

/** Walk in document order without adding recursion for author-controlled HTML. */
function* walkHtml(root: HtmlNode) {
  const pending = [{ node: root, inAside: false }];
  while (pending.length > 0) {
    const { node, inAside } = pending.pop()!;
    const excluded =
      inAside ||
      (node.type === "element" &&
        (node.tagName === "blockquote" || node.tagName === "aside"));
    yield { node, inAside: excluded };
    if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({ node: node.children[index]!, inAside: excluded });
      }
    }
  }
}

function paragraphText(paragraph: HtmlNode) {
  let text = "";
  for (const { node } of walkHtml(paragraph)) {
    if (node.type === "text") text += node.value;
    if (node.type === "element" && node.tagName === "br") text += "\n";
  }
  return text.trim();
}

/** Sanitize once and derive fallbacks from the same tree that produces the body. */
export function sanitizeEmbeddedContent(html: string) {
  const parsed = embeddedProcessor.parse(html);
  // Sanitization unwraps unsupported `aside` elements. Keep their paragraph
  // source offsets so that removing the wrapper does not make its text eligible.
  const asideParagraphs = new Set<number>();
  for (const { node, inAside } of walkHtml(parsed)) {
    if (inAside && node.type === "element" && node.tagName === "p") {
      const offset = node.position?.start.offset;
      if (offset !== undefined) asideParagraphs.add(offset);
    }
  }
  const sanitized = embeddedProcessor.runSync(parsed);
  let firstParagraph: string | null = null;
  let firstImageUrl: string | null = null;
  for (const { node, inAside } of walkHtml(sanitized)) {
    if (node.type !== "element") continue;
    if (
      firstParagraph === null &&
      node.tagName === "p" &&
      !inAside &&
      !asideParagraphs.has(node.position?.start.offset ?? -1)
    ) {
      firstParagraph = paragraphText(node) || null;
    }
    if (firstImageUrl === null && node.tagName === "img") {
      const src = node.properties.src;
      firstImageUrl = safeSourceUrl(typeof src === "string" ? src : undefined);
    }
  }
  return {
    html: String(embeddedProcessor.stringify(sanitized)),
    firstParagraph,
    firstImageUrl,
  };
}

export function sanitizeArticleHtml(html: string) {
  return String(articleProcessor.processSync(html));
}

export function sanitizeEmbeddedHtml(html: string) {
  return String(embeddedProcessor.processSync(html));
}

import rehypeParse from "rehype-parse";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import { safeSourceUrl } from "./urls";

/**
 * The schema every stored HTML body is a fixed point of. It extends the
 * rehype-sanitize default with underline, highlight, figures, and the one
 * element the default drops that the reader admits: an `iframe` reduced to
 * its `src` and `height`. Stored HTML never carries a live frame policy; the
 * reader decides at render time how External content is shown.
 *
 * Contract for callers: bodies from RSS or author HTML go through
 * `sanitizeEmbeddedHtml` once at ingest; the article schema prefixes `id` and
 * `name` on every pass and is therefore not idempotent on markup that carries
 * them. Block-native documents never become HTML; they derive to a Reader
 * document in the browser.
 */
export const ARTICLE_SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "u",
    "mark",
    "figure",
    "figcaption",
    "iframe",
  ],
  attributes: {
    ...defaultSchema.attributes,
    iframe: ["src", "height"],
  },
};

const CLOBBERED_ATTRIBUTES = new Set(defaultSchema.clobber ?? []);

/**
 * The article schema minus the attributes rehype prefixes against DOM clobbering
 * (`id`, `name`, and the aria references). Prefixing is applied on every pass, so
 * markup carrying those attributes can never be a sanitizer fixed point; RSS
 * bodies are sanitized with this schema at ingest.
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

const htmlParser = unified().use(rehypeParse, { fragment: true });
type HtmlTree = ReturnType<typeof htmlParser.parse>;
type HtmlNode = HtmlTree | HtmlTree["children"][number];

/** The attributes a stored frame keeps; the schema's global list would let more through. */
const STORED_IFRAME_ATTRIBUTES = new Set(["src", "height"]);

/** Reduce every frame to its source and height after the schema has run. */
function pruneStoredFrames() {
  return (tree: HtmlTree) => {
    for (const { node } of walkHtml(tree)) {
      if (node.type !== "element" || node.tagName !== "iframe") continue;
      for (const name of Object.keys(node.properties)) {
        if (!STORED_IFRAME_ATTRIBUTES.has(name)) delete node.properties[name];
      }
    }
  };
}

function buildProcessor(schema: SanitizeSchema) {
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, schema)
    .use(pruneStoredFrames)
    .use(rehypeStringify);
}

const embeddedProcessor = buildProcessor(EMBEDDED_HTML_SANITIZE_SCHEMA);

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

export function sanitizeEmbeddedHtml(html: string) {
  return String(embeddedProcessor.processSync(html));
}

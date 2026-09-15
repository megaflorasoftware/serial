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

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeSanitize, ARTICLE_SANITIZE_SCHEMA)
  .use(rehypeStringify);

export function sanitizeArticleHtml(html: string) {
  return String(processor.processSync(html));
}

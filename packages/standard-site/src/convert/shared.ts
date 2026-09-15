import type { FacetRenderContext } from "./facets";
import { renderFootnotes, renderRichText, richTextSchema } from "./facets";
import { heading, linkCard, paragraph } from "./html";
import { strongRefSchema } from "../lexicons";
import { buildBlueskyCdnImageUrl, buildBlueskyPostUrl } from "../uris";

export type ConvertedDocument = {
  html: string;
  /** Plaintext of the first paragraph, for the description fallback. */
  firstParagraph: string | null;
  /** First body image URL, for the thumbnail fallback. */
  firstImageUrl: string | null;
};

/** Deeper block nesting than this renders nothing, so hostile input cannot recurse unboundedly. */
export const MAX_BLOCK_NESTING_DEPTH = 32;

/**
 * Per-conversion state shared by the three converters: the repo DID that owns
 * every blob reference, the footnotes gathered while rendering facets, the first
 * paragraph and image seen so far, and the current nesting depth.
 */
export class ConversionContext implements FacetRenderContext {
  readonly footnotes: FacetRenderContext["footnotes"] = [];
  firstParagraph: string | null = null;
  firstImageUrl: string | null = null;
  private depth = 0;

  constructor(readonly did: string) {}

  imageUrl(cid: string) {
    return buildBlueskyCdnImageUrl(this.did, cid);
  }

  noteParagraph(plaintext: string) {
    const trimmed = plaintext.trim();
    if (this.firstParagraph === null && trimmed) this.firstParagraph = trimmed;
  }

  noteImage(url: string) {
    if (this.firstImageUrl === null) this.firstImageUrl = url;
  }

  /** Runs a nested render, or renders nothing past the depth limit. */
  nested(render: () => string) {
    if (this.depth >= MAX_BLOCK_NESTING_DEPTH) return "";
    this.depth += 1;
    try {
      return render();
    } finally {
      this.depth -= 1;
    }
  }

  finish(bodyHtml: string): ConvertedDocument {
    return {
      html: bodyHtml + renderFootnotes(this.footnotes),
      firstParagraph: this.firstParagraph,
      firstImageUrl: this.firstImageUrl,
    };
  }
}

export type Block = { $type: string } & Record<string, unknown>;

/** Strips the platform's block NSID prefix so each converter can switch on the short name. */
export function blockName(block: Block, prefix: string) {
  return block.$type.startsWith(prefix)
    ? block.$type.slice(prefix.length)
    : block.$type;
}

export function richTextParagraph(block: unknown, context: ConversionContext) {
  const text = richTextSchema.safeParse(block);
  if (!text.success || !text.data.plaintext.trim()) return "";
  context.noteParagraph(text.data.plaintext);
  return paragraph(renderRichText(text.data, context));
}

export function richTextHeading(
  block: Block,
  context: ConversionContext,
  defaultLevel = 2,
) {
  const text = richTextSchema.safeParse(block);
  if (!text.success || !text.data.plaintext.trim()) return "";
  const level = typeof block.level === "number" ? block.level : defaultLevel;
  return heading(level, renderRichText(text.data, context));
}

/** Every platform embeds a Bluesky post as a strongRef; all render as one link card. */
export function blueskyPostCard(ref: unknown) {
  const parsed = strongRefSchema.safeParse(ref);
  const href = parsed.success ? buildBlueskyPostUrl(parsed.data.uri) : null;
  return href ? linkCard({ href, title: "View post on Bluesky" }) : "";
}

/** An unknown block whose value carries `plaintext` still renders as a paragraph. */
export function unknownBlock(block: Block, context: ConversionContext) {
  return typeof block.plaintext === "string"
    ? richTextParagraph({ plaintext: block.plaintext }, context)
    : "";
}

export function stringProperty(block: Block, name: string) {
  const value = block[name];
  return typeof value === "string" ? value : undefined;
}

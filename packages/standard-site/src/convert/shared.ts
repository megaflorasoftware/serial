import type { FacetRenderContext } from "./facets";
import { renderFootnotes, renderRichText } from "./facets";
import { paragraph } from "./html";
import { buildBlueskyCdnImageUrl } from "../uris";

export type ConvertedDocument = {
  html: string;
  /** Plaintext of the first paragraph, for the description fallback. */
  firstParagraph: string | null;
  /** First body image URL, for the thumbnail fallback. */
  firstImageUrl: string | null;
};

/**
 * Per-conversion state shared by the three converters: the repo DID that owns
 * every blob reference, the footnotes gathered while rendering facets, and the
 * first paragraph and image seen so far.
 */
export class ConversionContext implements FacetRenderContext {
  readonly footnotes: FacetRenderContext["footnotes"] = [];
  firstParagraph: string | null = null;
  firstImageUrl: string | null = null;

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

  finish(bodyHtml: string): ConvertedDocument {
    return {
      html: bodyHtml + renderFootnotes(this.footnotes),
      firstParagraph: this.firstParagraph,
      firstImageUrl: this.firstImageUrl,
    };
  }
}

export function textParagraph(
  text: {
    plaintext: string;
    facets?: Parameters<typeof renderRichText>[0]["facets"];
  },
  context: ConversionContext,
) {
  if (!text.plaintext.trim()) return "";
  context.noteParagraph(text.plaintext);
  return paragraph(renderRichText(text, context));
}

/** An unknown block whose value carries `plaintext` still renders as a paragraph. */
export function unknownBlock(value: unknown, context: ConversionContext) {
  if (
    typeof value === "object" &&
    value !== null &&
    "plaintext" in value &&
    typeof value.plaintext === "string"
  ) {
    return textParagraph({ plaintext: value.plaintext }, context);
  }
  return "";
}

export function typeName(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const type = (value as { $type?: unknown }).$type;
  return typeof type === "string" ? type : null;
}

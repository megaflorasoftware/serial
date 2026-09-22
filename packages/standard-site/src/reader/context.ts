import { z } from "zod";
import type {
  ReaderAlign,
  ReaderAspectRatio,
  ReaderBlock,
  ReaderBlockValue,
  ReaderImage,
  ReaderRichText,
  ReaderWidth,
} from "./model";
import { resolveRichText, richTextContext, richTextSchema } from "./rich-text";
import type { RichTextContext } from "./rich-text";
import { strongRefSchema } from "../lexicons";
import { recordCard } from "../record-card";
import { recordPreview } from "../record-preview";
import type { RecordLookup } from "../record-preview";
import {
  buildBlueskyCdnImageUrl,
  buildBlueskyPostUrl,
  buildPdslsUrl,
  parseAtUri,
  socialPlatformOf,
} from "../uris";
import { socialPost, socialPostUrl } from "./social";
import { safeLinkUrl } from "../urls";
import { validEntriesSchema } from "../parse";
import { parseYouTubeReference } from "../youtube";

/** Deeper block nesting than this becomes one notice, so hostile input cannot recurse unboundedly. */
export const MAX_BLOCK_NESTING_DEPTH = 32;

export const blockSchema = z.looseObject({ $type: z.string() });
export const blockArraySchema = validEntriesSchema(blockSchema);
export type Block = z.infer<typeof blockSchema>;

/**
 * Per-derivation state shared by the three adapters: the repo DID that owns
 * every blob reference, the resolved records, the footnotes gathered while
 * resolving facets, and the current nesting depth.
 */
export class AdapterContext {
  readonly text: RichTextContext;
  private depth = 0;

  constructor(
    readonly did: string,
    readonly records: RecordLookup = () => undefined,
  ) {
    this.text = richTextContext(records);
  }

  get footnotes() {
    return this.text.footnotes;
  }

  richText(text: z.infer<typeof richTextSchema>): ReaderRichText {
    return resolveRichText(text, this.text);
  }

  /** CDN URL for a blob in a repo, or null when the cid is malformed. */
  imageUrl(cid: string, did: string = this.did) {
    return buildBlueskyCdnImageUrl(did, cid);
  }

  /**
   * Runs a nested derivation, or yields the depth notice past the limit so an
   * over-deep subtree costs one block and its ancestors still render.
   */
  nested<T>(render: () => T, exceeded: () => T): T {
    if (this.depth >= MAX_BLOCK_NESTING_DEPTH) return exceeded();
    this.depth += 1;
    try {
      return render();
    } finally {
      this.depth -= 1;
    }
  }

  nestedBlocks(render: () => ReaderBlock[], source: unknown) {
    return this.nested(render, () => [notice(source, "depth")]);
  }
}

export function block(
  source: unknown,
  value: ReaderBlockValue & { align?: ReaderAlign | null },
): ReaderBlock {
  return { source, align: null, ...value };
}

export function notice(
  source: unknown,
  reason: Extract<ReaderBlock, { kind: "notice" }>["reason"],
) {
  return block(source, { kind: "notice", reason });
}

/**
 * Strips the platform's block NSID prefix and any `#def` suffix (a `$type` may name
 * its main def explicitly) so each adapter can switch on the short name.
 */
export function blockName(value: Block, prefix: string) {
  const hash = value.$type.indexOf("#");
  const type = hash === -1 ? value.$type : value.$type.slice(0, hash);
  return type.startsWith(prefix) ? type.slice(prefix.length) : type;
}

export function stringProperty(value: Block, name: string) {
  const field = value[name];
  return typeof field === "string" ? field : undefined;
}

export function numberProperty(value: Block, name: string) {
  const field = value[name];
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

const ALIGNMENTS: Record<string, ReaderAlign> = {
  left: "left",
  center: "center",
  right: "right",
  justify: "justify",
};

/** Accepts `center`, `#textAlignCenter` and `lex:…#textAlignCenter` alike. */
export function readAlign(value: unknown): ReaderAlign | null {
  if (typeof value !== "string") return null;
  const fragment = value.includes("#")
    ? value.slice(value.indexOf("#") + 1)
    : value;
  const name = fragment.replace(/^textAlign/, "").toLowerCase();
  return ALIGNMENTS[name] ?? null;
}

const aspectRatioSchema = z.object({
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});

export function readAspectRatio(value: unknown): ReaderAspectRatio | null {
  const parsed = aspectRatioSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Pixel numbers, numeric strings, and `NNpx` or `NN%` strings; anything else is carried, not drawn. */
export function readWidth(value: unknown): ReaderWidth | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? { value, unit: "px" } : null;
  }
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px|%)?\s*$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!(amount > 0)) return null;
  const unit = match[2] === "%" ? "%" : "px";
  return unit === "%" && amount > 100 ? null : { value: amount, unit };
}

/** The lexicon range for authored frame heights. */
export function readFrameHeight(value: unknown) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 16 &&
    value <= 1600
    ? value
    : null;
}

export function image(
  url: string,
  options: {
    alt?: string;
    title?: string;
    aspectRatio?: unknown;
    width?: unknown;
    fullBleed?: unknown;
  } = {},
): ReaderImage {
  return {
    url,
    alt: options.alt ?? "",
    title: options.title ?? null,
    aspectRatio: readAspectRatio(options.aspectRatio),
    width: readWidth(options.width),
    fullBleed: options.fullBleed === true,
  };
}

export function richTextParagraph(
  source: Block,
  context: AdapterContext,
  align: ReaderAlign | null = null,
): ReaderBlock | null {
  const text = richTextSchema.safeParse(source);
  if (!text.success || !text.data.plaintext.trim()) return null;
  return block(source, {
    kind: "paragraph",
    content: context.richText(text.data),
    align,
  });
}

export function richTextHeading(
  source: Block,
  context: AdapterContext,
  align: ReaderAlign | null = null,
  defaultLevel = 2,
): ReaderBlock | null {
  const text = richTextSchema.safeParse(source);
  if (!text.success || !text.data.plaintext.trim()) return null;
  const raw = numberProperty(source, "level") ?? defaultLevel;
  const level = Math.min(6, Math.max(1, Math.round(raw))) as
    1 | 2 | 3 | 4 | 5 | 6;
  return block(source, {
    kind: "heading",
    level,
    content: context.richText(text.data),
    align,
  });
}

export function linkCard(
  source: unknown,
  input: {
    href: string | undefined;
    title?: string;
    description?: string;
    imageUrl?: string | null;
  },
  align: ReaderAlign | null = null,
): ReaderBlock | null {
  const href = safeLinkUrl(input.href);
  if (!href) return null;
  return block(source, {
    kind: "linkCard",
    href,
    title: input.title?.trim() || input.href!,
    description: input.description?.trim() || null,
    imageUrl: input.imageUrl ?? null,
    align,
  });
}

/** Every platform embeds a Bluesky post as a strongRef; all become one Record preview. */
export function blueskyPostBlock(
  source: unknown,
  ref: unknown,
  context: AdapterContext,
) {
  const parsed = strongRefSchema.safeParse(ref);
  if (!parsed.success || !buildBlueskyPostUrl(parsed.data.uri)) return null;
  return recordPreviewBlock(source, parsed.data.uri, context);
}

const SOCIAL_FALLBACK_TITLES = {
  bluesky: "Post on Bluesky",
  pckt: "Note on pckt",
} as const;

/**
 * A Bluesky post or pckt note as a card, or the row card to its page when the
 * snapshot is absent. The page is known from the URI alone, so the fallback
 * never shows the inspector or the raw URI.
 */
function socialPostBlock(
  source: unknown,
  uri: string,
  context: AdapterContext,
): ReaderBlock | null {
  const post = socialPost(uri, context);
  if (post) return block(source, { kind: "socialPost", post });
  const url = socialPostUrl(uri);
  const platform = socialPlatformOf(parseAtUri(uri)!.collection);
  const card =
    url && platform
      ? recordCard({ uri, url, title: SOCIAL_FALLBACK_TITLES[platform] }, "row")
      : null;
  return card ? block(source, { kind: "recordPreview", card }) : null;
}

/** A record reference the reader accepts: it must have an inspector URL. */
export function recordReferenceUri(uri: string | undefined) {
  return uri && buildPdslsUrl(uri) ? uri : null;
}

/**
 * A Record preview from the resolved snapshot, or the inspector fallback when
 * the record is unresolved. The uri is reported to the lookup either way so
 * import discovers it.
 */
export function recordPreviewBlock(
  source: unknown,
  uri: string,
  context: AdapterContext,
  size?: unknown,
  title = "Embedded record",
): ReaderBlock | null {
  const fallback = buildPdslsUrl(uri);
  if (!fallback) return null;
  if (socialPlatformOf(parseAtUri(uri)!.collection)) {
    // Reported to the lookup by socialPost, so discovery still sees it.
    return socialPostBlock(source, uri, context);
  }
  const preview = recordPreview(uri, context.records);
  const card = recordCard(
    { ...(preview ?? { url: fallback, title, description: uri }), uri },
    preview ? size : "row",
  );
  return card ? block(source, { kind: "recordPreview", card }) : null;
}

/** An unknown block whose value carries `plaintext` still renders as a paragraph. */
export function unknownBlock(source: Block, context: AdapterContext) {
  return typeof source.plaintext === "string"
    ? richTextParagraph({ ...source, plaintext: source.plaintext }, context)
    : notice(source, "unsupported");
}

export function embedBlock(
  source: unknown,
  input: {
    href: string | undefined;
    embedUrl?: string | undefined;
    height?: unknown;
    aspectRatio?: unknown;
  },
  align: ReaderAlign | null = null,
): ReaderBlock | null {
  const embedUrl = safeLinkUrl(input.embedUrl) ?? null;
  const href = safeLinkUrl(input.href) ?? embedUrl;
  if (!href) return notice(source, "unsupported");
  return block(source, {
    kind: "embed",
    href,
    embedUrl,
    youtube: parseYouTube(embedUrl) ?? parseYouTube(href),
    height: readFrameHeight(input.height),
    aspectRatio: readAspectRatio(input.aspectRatio),
    align,
  });
}

function parseYouTube(url: string | null) {
  return url ? parseYouTubeReference(url) : null;
}

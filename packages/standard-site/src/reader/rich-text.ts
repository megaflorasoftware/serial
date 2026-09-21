import { z } from "zod";
import type {
  ReaderFootnote,
  ReaderInline,
  ReaderLink,
  ReaderMarks,
  ReaderRichText,
  ReaderTextSpan,
} from "./model";
import { recordPreview } from "../record-preview";
import type { RecordLookup } from "../record-preview";
import { buildPdslsUrl, buildBlueskyProfileUrl } from "../uris";
import { safeLinkUrl } from "../urls";
import { validEntriesSchema } from "../parse";

/**
 * The three platforms share one rich-text model: plaintext plus byte-indexed facets
 * whose features name a formatting or link. Feature $types differ per platform only
 * in their NSID prefix, so features are matched on the fragment after `#`.
 */
export const facetSchema = z.object({
  index: z.object({ byteStart: z.int(), byteEnd: z.int() }),
  features: validEntriesSchema(z.looseObject({ $type: z.string() })),
});

export type Facet = z.infer<typeof facetSchema>;
export const facetArraySchema = validEntriesSchema(facetSchema);

export const richTextSchema = z.object({
  plaintext: z.string(),
  facets: facetArraySchema.optional().catch(undefined),
});

export type RichText = z.infer<typeof richTextSchema>;

type Feature = Facet["features"][number];

/**
 * Footnotes collected while resolving one document. References that carry the
 * same `footnoteId` share one number; a note published without an id is listed
 * once per reference, because nothing else identifies it.
 */
export type RichTextContext = {
  footnotes: ReaderFootnote[];
  records: RecordLookup;
  /** Numbers already given to ids, so a second reference reuses the first. */
  footnoteNumbers: Map<string, number>;
};

export function richTextContext(
  records: RecordLookup = () => undefined,
): RichTextContext {
  return { footnotes: [], records, footnoteNumbers: new Map() };
}

function featureName(feature: Feature) {
  const hash = feature.$type.indexOf("#");
  return hash === -1 ? feature.$type : feature.$type.slice(hash + 1);
}

function stringField(feature: Feature, name: string) {
  const value = feature[name];
  return typeof value === "string" ? value : undefined;
}

/** What one feature contributes: marks on the span, a link, or a note at its end. */
type Contribution = {
  marks?: ReaderMarks;
  link?: ReaderLink;
  footnote?: { id: string; text: RichText };
};

function contributionFor(
  feature: Feature,
  context: RichTextContext,
): Contribution | null {
  switch (featureName(feature)) {
    case "bold":
      return { marks: { bold: true } };
    case "italic":
      return { marks: { italic: true } };
    case "code":
      return { marks: { code: true } };
    case "strikethrough":
      return { marks: { strikethrough: true } };
    case "underline":
      return { marks: { underline: true } };
    case "highlight": {
      const color = feature.color;
      return {
        marks: {
          highlight: { color: typeof color === "string" ? color : null },
        },
      };
    }
    case "link":
    case "webMention": {
      const href = safeLinkUrl(stringField(feature, "uri"));
      return href ? { link: { href, record: null } } : null;
    }
    case "mention":
    case "didMention": {
      const did = stringField(feature, "did");
      const href = did ? buildBlueskyProfileUrl(did) : null;
      return href ? { link: { href, record: null } } : null;
    }
    case "atMention": {
      const uri = stringField(feature, "atURI");
      const fallback = uri ? buildPdslsUrl(uri) : null;
      const preview =
        uri && fallback ? recordPreview(uri, context.records) : null;
      const previewUrl = safeLinkUrl(preview?.url);
      const href =
        previewUrl && previewUrl !== fallback
          ? previewUrl
          : (safeLinkUrl(stringField(feature, "href")) ?? fallback);
      // A malformed URI has no inspector page, so the mention keeps only its
      // authored destination and is not a Record mention.
      return href ? { link: { href, record: fallback ? uri! : null } } : null;
    }
    case "footnote": {
      const text = stringField(feature, "contentPlaintext");
      if (text === undefined) return null;
      const facets = facetArraySchema.safeParse(feature.contentFacets);
      return {
        footnote: {
          id: stringField(feature, "footnoteId") ?? "",
          text: {
            plaintext: text,
            facets: facets.success ? facets.data : undefined,
          },
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Numbers a footnote when its reference is met, so numbering follows reading
 * order. Nested footnote text resolves with the same context and is listed
 * after its parent.
 */
function footnoteNumber(
  footnote: { id: string; text: RichText },
  context: RichTextContext,
) {
  const known = footnote.id
    ? context.footnoteNumbers.get(footnote.id)
    : undefined;
  if (known !== undefined) return known;
  const number = context.footnotes.length + 1;
  if (footnote.id) context.footnoteNumbers.set(footnote.id, number);
  const entry: ReaderFootnote = { number, content: [] };
  context.footnotes.push(entry);
  entry.content = resolveRichText(footnote.text, context);
  return number;
}

function isContinuationByte(byte: number | undefined) {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Moves a byte offset forward to the start of the next UTF-8 code point. */
function snapToCodePoint(bytes: Uint8Array, offset: number) {
  let snapped = Math.min(Math.max(offset, 0), bytes.length);
  while (snapped < bytes.length && isContinuationByte(bytes[snapped])) {
    snapped += 1;
  }
  return snapped;
}

type ResolvedFacet = { start: number; end: number; parts: Contribution[] };

function resolveFacets(
  facets: Facet[],
  bytes: Uint8Array,
  context: RichTextContext,
): ResolvedFacet[] {
  return facets
    .map((facet) => ({
      start: snapToCodePoint(bytes, facet.index.byteStart),
      end: snapToCodePoint(bytes, facet.index.byteEnd),
      features: facet.features,
    }))
    .filter((facet) => facet.end > facet.start)
    .map(({ start, end, features }) => ({
      start,
      end,
      parts: features
        .map((feature) => contributionFor(feature, context))
        .filter((part): part is Contribution => part !== null),
    }))
    .filter((facet) => facet.parts.length > 0)
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

/**
 * Resolves byte-indexed facets into inline spans. The plaintext is sliced as
 * UTF-8 bytes and decoded per segment; overlapping facets split at every
 * boundary, each segment carrying the union of active marks and the outermost
 * link. A footnote reference lands once where its facet ends.
 */
export function resolveRichText(
  text: RichText,
  context: RichTextContext = richTextContext(),
): ReaderRichText {
  const bytes = new TextEncoder().encode(text.plaintext);
  const facets = resolveFacets(text.facets ?? [], bytes, context);
  if (facets.length === 0) {
    return text.plaintext
      ? [{ kind: "text", text: text.plaintext, marks: {}, link: null }]
      : [];
  }

  const boundaries = new Set<number>([0, bytes.length]);
  const endings = new Map<number, ResolvedFacet[]>();
  for (const facet of facets) {
    boundaries.add(facet.start);
    boundaries.add(facet.end);
    const ending = endings.get(facet.end) ?? [];
    ending.push(facet);
    endings.set(facet.end, ending);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  // Insertion order matches the sorted facets, so the first link met stays
  // the outermost one while only active ranges are visited at each boundary.
  const active = new Set<ResolvedFacet>();
  let next = 0;

  const inlines: ReaderInline[] = [];
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const from = offsets[index]!;
    const to = offsets[index + 1]!;
    for (const facet of endings.get(from) ?? []) active.delete(facet);
    while (next < facets.length && facets[next]!.start === from) {
      active.add(facets[next]!);
      next += 1;
    }
    const marks: ReaderMarks = {};
    let link: ReaderLink | null = null;
    for (const facet of active) {
      for (const part of facet.parts) {
        if (part.marks) Object.assign(marks, part.marks);
        if (part.link && !link) link = part.link;
      }
    }
    const segment = decoder.decode(bytes.subarray(from, to));
    if (segment)
      pushText(inlines, { kind: "text", text: segment, marks, link });
    for (const facet of active) {
      if (facet.end !== to) continue;
      for (const part of facet.parts) {
        if (part.footnote)
          inlines.push({
            kind: "footnote",
            number: footnoteNumber(part.footnote, context),
          });
      }
    }
  }
  return inlines;
}

function sameFormatting(left: ReaderTextSpan, right: ReaderTextSpan) {
  const marks = (span: ReaderTextSpan) =>
    JSON.stringify(span.marks, Object.keys(span.marks).sort());
  return (
    marks(left) === marks(right) &&
    left.link?.href === right.link?.href &&
    left.link?.record === right.link?.record
  );
}

/** Facet boundaries split text; two spans that look the same join back up. */
function pushText(inlines: ReaderInline[], span: ReaderTextSpan) {
  const last = inlines.at(-1);
  if (last?.kind === "text" && sameFormatting(last, span)) {
    last.text += span.text;
    return;
  }
  inlines.push(span);
}

/** The plaintext of resolved inline content, footnote markers excluded. */
export function richTextPlaintext(content: ReaderRichText) {
  let text = "";
  for (const inline of content) if (inline.kind === "text") text += inline.text;
  return text;
}

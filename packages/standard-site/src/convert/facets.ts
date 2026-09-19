import { z } from "zod";
import {
  closeTag,
  element,
  escapeText,
  list,
  openTag,
  safeLinkUrl,
  type Attributes,
} from "./html";
import { recordPreview } from "../record-preview";
import type { RecordLookup } from "../record-preview";
import { buildPdslsUrl, buildBlueskyProfileUrl } from "../uris";
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
 * One collected footnote. References that carry the same `footnoteId` share one
 * entry; a note published without an id is listed once per reference, because
 * nothing else identifies it. Markers are positional, since the sanitizer
 * rewrites element ids and in-page anchors are therefore not possible.
 */
export type Footnote = { id: string; text: RichText };

export type FacetRenderContext = {
  footnotes: Footnote[];
  records?: RecordLookup;
  /** Index of the append-only footnotes collected during this conversion. */
  footnoteNumbers?: Map<string, number>;
};

function footnoteNumbers(context: FacetRenderContext) {
  if (!context.footnoteNumbers) {
    const numbers = new Map<string, number>();
    context.footnotes.forEach((footnote, index) => {
      if (footnote.id && !numbers.has(footnote.id)) {
        numbers.set(footnote.id, index + 1);
      }
    });
    context.footnoteNumbers = numbers;
  }
  return context.footnoteNumbers;
}

function featureName(feature: Feature) {
  const hash = feature.$type.indexOf("#");
  return hash === -1 ? feature.$type : feature.$type.slice(hash + 1);
}

function stringField(feature: Feature, name: string) {
  const value = feature[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * How one feature renders: an inline element wrapping the facet's text, a marker
 * appended once where the facet ends, or both.
 */
type Wrapper = {
  tag?: string;
  attributes?: Attributes;
  footnote?: Footnote;
};

function inlineTag(tag: string): Wrapper {
  return { tag };
}

function link(href: string | null): Wrapper | null {
  return href ? { tag: "a", attributes: { href } } : null;
}

function wrapperFor(
  feature: Feature,
  context: FacetRenderContext,
): Wrapper | null {
  switch (featureName(feature)) {
    case "bold":
      return inlineTag("strong");
    case "italic":
      return inlineTag("em");
    case "code":
      return inlineTag("code");
    case "strikethrough":
      return inlineTag("del");
    case "underline":
      return inlineTag("u");
    case "highlight":
      return inlineTag("mark");
    case "link":
    case "webMention":
      return link(safeLinkUrl(stringField(feature, "uri")));
    case "mention":
    case "didMention": {
      const did = stringField(feature, "did");
      return did ? link(buildBlueskyProfileUrl(did)) : null;
    }
    case "atMention": {
      const uri = stringField(feature, "atURI");
      const fallback = uri ? buildPdslsUrl(uri) : null;
      const preview =
        fallback && context.records
          ? recordPreview(uri!, context.records)
          : null;
      const wrapper = link(
        safeLinkUrl(preview?.url) && preview?.url !== fallback
          ? safeLinkUrl(preview?.url)
          : (safeLinkUrl(stringField(feature, "href")) ?? fallback),
      );
      if (wrapper && fallback)
        wrapper.attributes = { ...wrapper.attributes, "data-record-uri": uri };
      return wrapper;
    }
    case "footnote": {
      const text = stringField(feature, "contentPlaintext");
      if (text === undefined) return null;
      const id = stringField(feature, "footnoteId");
      const facets = facetArraySchema.safeParse(feature.contentFacets);
      return {
        footnote: {
          id: id ?? "",
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

/** Allocate numbers when references appear, rather than when facets are parsed. */
function footnoteMarker(footnote: Footnote, context: FacetRenderContext) {
  const numbers = footnoteNumbers(context);
  let number = footnote.id ? numbers.get(footnote.id) : undefined;
  if (number === undefined) {
    context.footnotes.push(footnote);
    number = context.footnotes.length;
    if (footnote.id) numbers.set(footnote.id, number);
  }
  return element("sup", undefined, `[${number}]`);
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

type ResolvedFacet = { start: number; end: number; wrappers: Wrapper[] };

function resolveFacets(
  facets: Facet[],
  bytes: Uint8Array,
  context: FacetRenderContext,
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
      wrappers: features
        .map((feature) => wrapperFor(feature, context))
        .filter((wrapper): wrapper is Wrapper => wrapper !== null),
    }))
    .filter((facet) => facet.wrappers.length > 0)
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

/** Duplicate formatting adds no content and must not create unbounded nesting. */
function distinctFormatting(wrappers: Wrapper[]) {
  if (wrappers.length < 2) return wrappers;
  const seenTags = new Set<string>();
  return wrappers.filter((wrapper) => {
    if (!wrapper.tag) return true;
    // The first anchor still wins when link facets overlap.
    if (seenTags.has(wrapper.tag)) return false;
    seenTags.add(wrapper.tag);
    return true;
  });
}

/**
 * Renders facets as nested inline elements. Facets are byte-indexed, so the
 * plaintext is sliced as UTF-8 bytes and decoded per segment. Overlapping facets
 * are closed and reopened at every boundary so the output stays well formed.
 */
export function renderRichText(
  text: RichText,
  context: FacetRenderContext = { footnotes: [] },
) {
  const bytes = new TextEncoder().encode(text.plaintext);
  const facets = resolveFacets(text.facets ?? [], bytes, context);
  if (facets.length === 0) return escapeText(text.plaintext);

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
  // Insertion order matches the sorted facets, preserving outermost-link
  // precedence while visiting only active ranges at each boundary.
  const activeFacets = new Set<ResolvedFacet>();
  let nextFacet = 0;

  let html = "";
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const from = offsets[index]!;
    const to = offsets[index + 1]!;
    for (const facet of endings.get(from) ?? []) activeFacets.delete(facet);
    while (nextFacet < facets.length && facets[nextFacet]!.start === from) {
      activeFacets.add(facets[nextFacet]!);
      nextFacet += 1;
    }
    const active = [...activeFacets];
    const wrappers = distinctFormatting(
      active.flatMap((facet) => facet.wrappers),
    );
    const tagged = wrappers.filter(
      (wrapper): wrapper is Wrapper & { tag: string } => !!wrapper.tag,
    );
    const markers = active
      .filter((facet) => facet.end === to)
      .flatMap((facet) => facet.wrappers)
      .map((wrapper) =>
        wrapper.footnote ? footnoteMarker(wrapper.footnote, context) : "",
      )
      .join("");

    html +=
      tagged
        .map((wrapper) => openTag(wrapper.tag, wrapper.attributes))
        .join("") +
      escapeText(decoder.decode(bytes.subarray(from, to))) +
      [...tagged]
        .reverse()
        .map((wrapper) => closeTag(wrapper.tag))
        .join("") +
      markers;
  }
  return html;
}

/**
 * Renders the collected footnotes. Rendering with the same context lets a
 * footnote inside footnote text register and be listed after it.
 */
export function renderFootnotes(context: FacetRenderContext) {
  const items: string[] = [];
  for (let index = 0; index < context.footnotes.length; index += 1) {
    const footnote = context.footnotes[index]!;
    items.push(
      element("li", undefined, renderRichText(footnote.text, context)),
    );
  }
  const rendered = list(true, items);
  return rendered ? element("section", undefined, rendered) : "";
}

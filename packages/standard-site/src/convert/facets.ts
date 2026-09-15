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
import { buildBlueskyProfileUrl } from "../uris";

/**
 * The three platforms share one rich-text model: plaintext plus byte-indexed facets
 * whose features name a formatting or link. Feature $types differ per platform only
 * in their NSID prefix, so features are matched on the fragment after `#`.
 */
export const facetSchema = z.object({
  index: z.object({ byteStart: z.int(), byteEnd: z.int() }),
  features: z.array(z.looseObject({ $type: z.string() })),
});

export type Facet = z.infer<typeof facetSchema>;

export const richTextSchema = z.object({
  plaintext: z.string(),
  facets: z.array(facetSchema).optional(),
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
};

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
  marker?: string;
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
    case "atMention":
      return link(safeLinkUrl(stringField(feature, "href")));
    case "footnote": {
      const text = stringField(feature, "contentPlaintext");
      if (text === undefined) return null;
      const id = stringField(feature, "footnoteId");
      const existing = id
        ? context.footnotes.findIndex((footnote) => footnote.id === id)
        : -1;
      if (existing === -1) {
        const facets = z.array(facetSchema).safeParse(feature.contentFacets);
        context.footnotes.push({
          id: id ?? "",
          text: {
            plaintext: text,
            facets: facets.success ? facets.data : undefined,
          },
        });
      }
      const number = existing === -1 ? context.footnotes.length : existing + 1;
      return { marker: element("sup", undefined, `[${number}]`) };
    }
    default:
      return null;
  }
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

/** Nested anchors are invalid HTML, so only the outermost link wraps a segment. */
function withoutNestedAnchors(wrappers: Wrapper[]) {
  let seenAnchor = false;
  return wrappers.filter((wrapper) => {
    if (wrapper.tag !== "a") return true;
    if (seenAnchor) return false;
    seenAnchor = true;
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
  for (const facet of facets) {
    boundaries.add(facet.start);
    boundaries.add(facet.end);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  const decoder = new TextDecoder();

  let html = "";
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const from = offsets[index]!;
    const to = offsets[index + 1]!;
    const active = facets.filter(
      (facet) => facet.start <= from && facet.end >= to,
    );
    const wrappers = withoutNestedAnchors(
      active.flatMap((facet) => facet.wrappers),
    );
    const tagged = wrappers.filter(
      (wrapper): wrapper is Wrapper & { tag: string } => !!wrapper.tag,
    );
    const markers = active
      .filter((facet) => facet.end === to)
      .flatMap((facet) => facet.wrappers)
      .map((wrapper) => wrapper.marker ?? "")
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

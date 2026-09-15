import { z } from "zod";
import { anchor, element, escapeText, safeLinkUrl } from "./html";
import { buildBlueskyProfileUrl } from "../uris";

/**
 * The three platforms share one rich-text model: plaintext plus byte-indexed facets
 * whose features name a formatting or link. Feature $types differ per platform only
 * in their NSID prefix, so features are matched on the fragment after `#`.
 */
export const facetSchema = z.object({
  index: z.object({ byteStart: z.number(), byteEnd: z.number() }),
  features: z.array(z.object({ $type: z.string() }).passthrough()),
});

export type Facet = z.infer<typeof facetSchema>;

export const richTextSchema = z.object({
  plaintext: z.string(),
  facets: z.array(facetSchema).optional(),
});

export type RichText = z.infer<typeof richTextSchema>;

type Feature = Facet["features"][number];

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

type Wrapper = { open: string; close: string };

function wrapperFor(
  feature: Feature,
  context: FacetRenderContext,
): Wrapper | null {
  const name = featureName(feature);
  switch (name) {
    case "bold":
      return { open: "<strong>", close: "</strong>" };
    case "italic":
      return { open: "<em>", close: "</em>" };
    case "code":
      return { open: "<code>", close: "</code>" };
    case "strikethrough":
      return { open: "<del>", close: "</del>" };
    case "underline":
      return { open: "<u>", close: "</u>" };
    case "highlight":
      return { open: "<mark>", close: "</mark>" };
    case "link":
    case "webMention": {
      const href = safeLinkUrl(stringField(feature, "uri"));
      return href ? { open: `<a href="${href}">`, close: "</a>" } : null;
    }
    case "mention":
    case "didMention": {
      const did = stringField(feature, "did");
      if (!did) return null;
      return {
        open: `<a href="${buildBlueskyProfileUrl(did)}">`,
        close: "</a>",
      };
    }
    case "atMention": {
      const href = safeLinkUrl(stringField(feature, "href"));
      return href ? { open: `<a href="${href}">`, close: "</a>" } : null;
    }
    case "footnote": {
      const text = stringField(feature, "contentPlaintext");
      if (text === undefined) return null;
      const id =
        stringField(feature, "footnoteId") ??
        String(context.footnotes.length + 1);
      const contentFacets = feature.contentFacets;
      const facets = z.array(facetSchema).safeParse(contentFacets);
      context.footnotes.push({
        id,
        text: {
          plaintext: text,
          facets: facets.success ? facets.data : undefined,
        },
      });
      const marker = element("sup", undefined, `[${context.footnotes.length}]`);
      return { open: "", close: marker };
    }
    default:
      return null;
  }
}

type Boundary = { offset: number; open: Wrapper[]; close: Wrapper[] };

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
  const decoder = new TextDecoder();
  const facets = (text.facets ?? [])
    .filter(
      (facet) =>
        facet.index.byteStart >= 0 &&
        facet.index.byteEnd > facet.index.byteStart &&
        facet.index.byteStart < bytes.length,
    )
    .map((facet) => ({
      start: facet.index.byteStart,
      end: Math.min(facet.index.byteEnd, bytes.length),
      wrappers: facet.features
        .map((feature) => wrapperFor(feature, context))
        .filter((wrapper): wrapper is Wrapper => wrapper !== null),
    }))
    .filter((facet) => facet.wrappers.length > 0)
    .sort((left, right) => left.start - right.start || right.end - left.end);

  if (facets.length === 0) return escapeText(text.plaintext);

  const boundaries = new Set<number>([0, bytes.length]);
  for (const facet of facets) {
    boundaries.add(facet.start);
    boundaries.add(facet.end);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);

  let html = "";
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const from = offsets[index]!;
    const to = offsets[index + 1]!;
    const active = facets.filter(
      (facet) => facet.start <= from && facet.end >= to,
    );
    const segment = escapeText(decoder.decode(bytes.subarray(from, to)));
    const wrappers = active.flatMap((facet) => facet.wrappers);
    html +=
      wrappers.map((wrapper) => wrapper.open).join("") +
      segment +
      [...wrappers]
        .reverse()
        .map((wrapper) => wrapper.close)
        .join("");
  }
  return html;
}

export function renderFootnotes(footnotes: Footnote[]) {
  if (footnotes.length === 0) return "";
  const items = footnotes.map((footnote) =>
    element("li", undefined, renderRichText(footnote.text)),
  );
  return element(
    "section",
    undefined,
    element("ol", undefined, items.join("")),
  );
}

export { anchor };

import type { z } from "zod";
import type { ContentPlatform } from "@serial/content";
import type { AdapterContext } from "./context";
import type { ReaderBlock } from "./model";

/**
 * The facet features an adapter's rich text may carry. Facet mechanics
 * (byte ranges, span splitting, footnote numbering) are shared; which feature
 * names mean what is data the adapter supplies. Every table uses the short
 * name after `#`; the platform's NSID prefix is implied.
 */
export type FacetFeature =
  | "bold"
  | "italic"
  | "code"
  | "strikethrough"
  | "underline"
  | "highlight"
  | "link"
  | "webMention"
  | "mention"
  | "didMention"
  | "atMention"
  | "footnote";

/**
 * One platform's content adapter: how its content `$type` is recognized,
 * parsed, resolved from an overflow blob and derived into Reader blocks, and
 * which platform a Feed made of such documents is.
 */
export type PlatformAdapter<TContent = unknown> = {
  /** The content union member this adapter reads, e.g. `pub.leaflet.content`. */
  contentType: string;
  platform: ContentPlatform;
  schema: z.ZodType<TContent>;
  /** The cid of the one overflow blob a content object may point at, if any. */
  overflowBlobCid: (content: TContent) => string | null;
  /**
   * The content with its overflow blob pulled back inline, or null when the
   * blob bytes do not decode to the platform's shape.
   */
  inlineOverflow: (content: TContent, blob: unknown) => TContent | null;
  derive: (content: TContent, context: AdapterContext) => ReaderBlock[];
  facetFeatures: readonly FacetFeature[];
  /** Record collections this adapter reads through the lookup, beyond documents and publications. */
  referenceCollections: readonly string[];
};

export function defineAdapter<TContent>(
  adapter: PlatformAdapter<TContent>,
): PlatformAdapter<TContent> {
  return adapter;
}

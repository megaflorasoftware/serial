import { z } from "zod";
import type { ContentPlatform } from "@serial/content";
import { leafletAdapter } from "./leaflet";
import { offprintAdapter } from "./offprint";
import { pcktAdapter } from "./pckt";
import type { PlatformAdapter } from "./adapter";

/**
 * Every platform adapter, keyed by the content `$type` it reads. Block-native
 * checks, overflow lookup, derivation, Feed platform detection and the
 * reference-snapshot allowlist all read this table; nothing else lists a
 * content type.
 */
export const PLATFORM_ADAPTERS: ReadonlyMap<string, PlatformAdapter> = new Map<
  string,
  PlatformAdapter
>(
  [leafletAdapter, pcktAdapter, offprintAdapter].map((adapter) => [
    adapter.contentType,
    adapter as PlatformAdapter,
  ]),
);

export const BLOCK_NATIVE_CONTENT_TYPES = [...PLATFORM_ADAPTERS.keys()];

const typedContentSchema = z.looseObject({ $type: z.string() });

/** The adapter for a content object, by its `$type`; null for anything unregistered. */
export function adapterFor(content: unknown): PlatformAdapter | null {
  const typed = typedContentSchema.safeParse(content);
  return typed.success
    ? (PLATFORM_ADAPTERS.get(typed.data.$type) ?? null)
    : null;
}

export function isBlockNativeContentType(type: string | undefined) {
  return type !== undefined && PLATFORM_ADAPTERS.has(type);
}

/**
 * The platform a document contributes to its Feed: the registered adapter's
 * platform, or `website` for no content or an unregistered type.
 */
export function platformOfContentType(
  type: string | null | undefined,
): ContentPlatform {
  return (type && PLATFORM_ADAPTERS.get(type)?.platform) || "website";
}

/** Collections an adapter reads through the lookup, beyond documents and publications. */
export const ADAPTER_REFERENCE_COLLECTIONS = [
  ...new Set(
    [...PLATFORM_ADAPTERS.values()].flatMap(
      (adapter) => adapter.referenceCollections,
    ),
  ),
];

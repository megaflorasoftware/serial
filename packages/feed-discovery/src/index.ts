// Zod 3 does not generate code at runtime, as required by extension store policies.
import { z } from "zod/v3";
export {
  collapseSyndicationAlternates,
  combinePublicationRows,
} from "./grouping";
export type { SyndicationCandidate } from "./grouping";

export const DISCOVERY_LIMIT = 16;
export const DISCOVERY_QUERY_LIMIT = 1024;

export function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const httpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => httpUrl(value) !== null);
export const discoveredOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rss"),
    locator: httpUrlSchema,
    format: z.string().max(32).optional(),
    alternateUrls: z.array(httpUrlSchema).max(DISCOVERY_LIMIT).optional(),
  }),
  z.object({
    kind: z.literal("atproto"),
    locator: z.string().max(1024).startsWith("at://"),
  }),
]);

/** Additive fields preserve discovery responses from older extension servers. */
export const discoveredFeedSchema = z.object({
  url: httpUrlSchema,
  title: z.string().max(2048).optional(),
  format: z.string().max(32).optional(),
  siteUrl: httpUrlSchema.optional(),
  imageUrl: httpUrlSchema.optional(),
  origins: z
    .array(discoveredOriginSchema)
    .min(1)
    .max(2)
    .refine(
      (origins) =>
        new Set(origins.map((origin) => origin.kind)).size === origins.length,
    )
    .optional(),
});
export type DiscoveredFeed = z.infer<typeof discoveredFeedSchema>;
export type DiscoveredOrigin = z.infer<typeof discoveredOriginSchema>;

export function parseDiscoveredFeeds(value: unknown): DiscoveredFeed[] | null {
  const parsed = z
    .array(discoveredFeedSchema)
    .max(DISCOVERY_LIMIT)
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function feedDiscoveryKey(feed: DiscoveredFeed): string {
  return (
    feed.origins?.find((origin) => origin.kind === "atproto")?.locator ??
    feed.url
  );
}

export function feedSourceLabel(feed: DiscoveredFeed): string {
  const kinds = new Set(feed.origins?.map((origin) => origin.kind) ?? ["rss"]);
  return kinds.has("rss") && kinds.has("atproto")
    ? "RSS · Atmosphere"
    : kinds.has("atproto")
      ? "Atmosphere"
      : "RSS";
}

export type DiscoveryInput = {
  websiteUrl?: string;
  actorQuery?: string;
  publicationUri?: string;
};

export function classifyDiscoveryInput(value: string): DiscoveryInput | null {
  const input = value.trim();
  if (!input || input.length > DISCOVERY_QUERY_LIMIT) return null;
  if (input.startsWith("at://")) return { publicationUri: input };
  if (input.startsWith("@"))
    return input.length > 1 ? { actorQuery: input.slice(1) } : null;
  if (/^https?:\/\//i.test(input)) {
    const websiteUrl = httpUrl(input);
    if (!websiteUrl) return null;
    const url = new URL(websiteUrl);
    if (url.hostname === "pdsls.dev" && url.pathname.startsWith("/at://")) {
      try {
        return { publicationUri: decodeURIComponent(url.pathname.slice(1)) };
      } catch {
        return null;
      }
    }
    return { websiteUrl };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return null;
  const websiteUrl = httpUrl(`https://${input}`);
  if (
    websiteUrl &&
    !/\s/.test(input) &&
    new URL(websiteUrl).hostname.includes(".")
  ) {
    const bareDomain = !/[/?#:]/.test(input);
    return { websiteUrl, ...(bareDomain ? { actorQuery: input } : {}) };
  }
  return { actorQuery: input };
}

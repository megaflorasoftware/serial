// Zod 3 does not generate code at runtime, as required by extension store policies.
import { z } from "zod/v3";
import { DISCOVERY_LIMIT, httpUrl } from "./index";

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

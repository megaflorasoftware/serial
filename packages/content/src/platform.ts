import { z } from "zod";

/**
 * The provider that owns a content item's primary resource. `website` is the
 * fallback for anything without a more specific provider; the three
 * Atmosphere platforms are text platforms in their own right.
 */
export const CONTENT_PLATFORM = {
  WEBSITE: "website",
  YOUTUBE: "youtube",
  PEERTUBE: "peertube",
  NEBULA: "nebula",
  LEAFLET: "leaflet",
  PCKT: "pckt",
  OFFPRINT: "offprint",
} as const;

export const CONTENT_PLATFORMS = [
  CONTENT_PLATFORM.WEBSITE,
  CONTENT_PLATFORM.YOUTUBE,
  CONTENT_PLATFORM.PEERTUBE,
  CONTENT_PLATFORM.NEBULA,
  CONTENT_PLATFORM.LEAFLET,
  CONTENT_PLATFORM.PCKT,
  CONTENT_PLATFORM.OFFPRINT,
] as const;

export const contentPlatformSchema = z.enum(CONTENT_PLATFORMS);
export type ContentPlatform = z.infer<typeof contentPlatformSchema>;

export const CONTENT_TYPE = {
  TEXT: "text",
  VIDEO: "video",
} as const;

export const contentTypeSchema = z.enum([
  CONTENT_TYPE.TEXT,
  CONTENT_TYPE.VIDEO,
]);
export type ContentType = z.infer<typeof contentTypeSchema>;

/**
 * The medium a platform's Feeds carry: what an item from that platform is
 * before any per-item evidence. Every text-versus-video decision reads this
 * table, so a new text platform is one row here.
 */
export const PLATFORM_MEDIUM = {
  website: CONTENT_TYPE.TEXT,
  youtube: CONTENT_TYPE.VIDEO,
  peertube: CONTENT_TYPE.VIDEO,
  nebula: CONTENT_TYPE.VIDEO,
  leaflet: CONTENT_TYPE.TEXT,
  pckt: CONTENT_TYPE.TEXT,
  offprint: CONTENT_TYPE.TEXT,
} as const satisfies Record<ContentPlatform, ContentType>;

function isContentPlatform(value: string): value is ContentPlatform {
  return Object.hasOwn(PLATFORM_MEDIUM, value);
}

/**
 * The medium of a platform. Stored platform columns are untyped text, so an
 * unknown value reads as the `website` fallback rather than failing.
 */
export function contentMediumOf(platform: string): ContentType {
  return isContentPlatform(platform)
    ? PLATFORM_MEDIUM[platform]
    : PLATFORM_MEDIUM.website;
}

export function isTextPlatform(platform: string) {
  return contentMediumOf(platform) === CONTENT_TYPE.TEXT;
}

export function isVideoPlatform(platform: string) {
  return contentMediumOf(platform) === CONTENT_TYPE.VIDEO;
}

/** Every platform of one medium, for SQL `IN` predicates and membership checks. */
export function platformsOfMedium(medium: ContentType): ContentPlatform[] {
  return CONTENT_PLATFORMS.filter(
    (platform) => contentMediumOf(platform) === medium,
  );
}

export const TEXT_PLATFORMS = platformsOfMedium(CONTENT_TYPE.TEXT);
export const VIDEO_PLATFORMS = platformsOfMedium(CONTENT_TYPE.VIDEO);

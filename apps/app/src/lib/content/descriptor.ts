import { z } from "zod";
import {
  CONTENT_TYPE,
  contentMediumOf,
  contentPlatformSchema,
  contentTypeSchema,
} from "@serial/content";

export {
  CONTENT_PLATFORM,
  CONTENT_PLATFORMS,
  CONTENT_TYPE,
  contentMediumOf,
  contentPlatformSchema,
  contentTypeSchema,
  isTextPlatform,
  isVideoPlatform,
  platformsOfMedium,
  TEXT_PLATFORMS,
  VIDEO_PLATFORMS,
} from "@serial/content";
export type { ContentPlatform, ContentType } from "@serial/content";

/** The route an item of a platform opens in: the reader for text, the player for video. */
export function itemDestinationOf(platform: string) {
  return contentMediumOf(platform) === CONTENT_TYPE.TEXT ? "read" : "watch";
}

export const VIDEO_ORIENTATION = {
  HORIZONTAL: "horizontal",
  VERTICAL: "vertical",
} as const;

export const videoOrientationSchema = z.enum([
  VIDEO_ORIENTATION.HORIZONTAL,
  VIDEO_ORIENTATION.VERTICAL,
]);
export type VideoOrientation = z.infer<typeof videoOrientationSchema>;

export const contentDescriptorSchema = z
  .object({
    platform: contentPlatformSchema,
    contentType: contentTypeSchema,
    orientation: videoOrientationSchema.nullable(),
    contentId: z.string().min(1).nullable(),
  })
  .superRefine((descriptor, context) => {
    if (
      descriptor.contentType === CONTENT_TYPE.TEXT &&
      descriptor.orientation !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Text content cannot have a video orientation",
        path: ["orientation"],
      });
    }
  });

export type ContentDescriptor = z.infer<typeof contentDescriptorSchema>;

export const OBSERVATION_SOURCE = {
  EXTENSION_LIVE_DOM: "extension-live-dom",
  SERVER_STATIC_FETCH: "server-static-fetch",
  URL: "url",
} as const;

export const observationSourceSchema = z.enum([
  OBSERVATION_SOURCE.EXTENSION_LIVE_DOM,
  OBSERVATION_SOURCE.SERVER_STATIC_FETCH,
  OBSERVATION_SOURCE.URL,
]);
export type ObservationSource = z.infer<typeof observationSourceSchema>;

const OBSERVATION_CONFIDENCE: Record<ObservationSource, number> = {
  [OBSERVATION_SOURCE.URL]: 0,
  [OBSERVATION_SOURCE.SERVER_STATIC_FETCH]: 1,
  [OBSERVATION_SOURCE.EXTENSION_LIVE_DOM]: 2,
};

export function compareObservationSources(
  left: ObservationSource,
  right: ObservationSource,
) {
  return OBSERVATION_CONFIDENCE[left] - OBSERVATION_CONFIDENCE[right];
}

export function effectiveVideoOrientation(
  orientation: VideoOrientation | null,
): VideoOrientation {
  return orientation ?? VIDEO_ORIENTATION.HORIZONTAL;
}

export function normalizeContentDescriptor(
  descriptor: ContentDescriptor,
): ContentDescriptor {
  return contentDescriptorSchema.parse({
    ...descriptor,
    orientation:
      descriptor.contentType === CONTENT_TYPE.TEXT
        ? null
        : descriptor.orientation,
    contentId: descriptor.contentId?.trim() || null,
  });
}

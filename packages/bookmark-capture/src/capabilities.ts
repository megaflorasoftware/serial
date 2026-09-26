import type { ContentPlatform, ContentType } from "@serial/content";

export {
  CONTENT_CAPABILITIES,
  getContentCapability,
} from "@serial/content";
export type { ContentCapability, NativeOpeningBehavior } from "@serial/content";

/** Bookmarks classify into the shared platform enum; the Atmosphere platforms never come from a URL. */
export type BookmarkContentPlatform = ContentPlatform;
export type BookmarkContentType = ContentType;

export type BookmarkContentDescriptor = {
  platform: BookmarkContentPlatform;
  contentType: BookmarkContentType;
};

import type { ContentPlatform, ContentType } from "./platform";

export type ContentDescriptorKey = {
  platform: ContentPlatform;
  contentType: ContentType;
};

export type NativeOpeningBehavior = "reader" | "player" | "origin";

export type ContentCapability = {
  nativeOpening: NativeOpeningBehavior;
  pageCapture: "allowed" | "disallowed";
  originActionLabel: string;
};

/** Text on an author's own site: opens in the reader, and only a website page may be captured. */
const OPEN_IN_WEBSITE = "Open in Website";

const ATMOSPHERE_TEXT = {
  text: {
    nativeOpening: "reader",
    pageCapture: "disallowed",
    originActionLabel: OPEN_IN_WEBSITE,
  },
  video: {
    nativeOpening: "origin",
    pageCapture: "disallowed",
    originActionLabel: OPEN_IN_WEBSITE,
  },
} as const satisfies Record<ContentType, ContentCapability>;

export const CONTENT_CAPABILITIES = {
  website: {
    text: {
      nativeOpening: "reader",
      pageCapture: "allowed",
      originActionLabel: OPEN_IN_WEBSITE,
    },
    video: {
      nativeOpening: "origin",
      pageCapture: "disallowed",
      originActionLabel: OPEN_IN_WEBSITE,
    },
  },
  youtube: {
    text: {
      nativeOpening: "origin",
      pageCapture: "disallowed",
      originActionLabel: "View on YouTube",
    },
    video: {
      nativeOpening: "player",
      pageCapture: "disallowed",
      originActionLabel: "View on YouTube",
    },
  },
  peertube: {
    text: {
      nativeOpening: "origin",
      pageCapture: "disallowed",
      originActionLabel: "View on PeerTube",
    },
    video: {
      nativeOpening: "player",
      pageCapture: "disallowed",
      originActionLabel: "View on PeerTube",
    },
  },
  nebula: {
    text: {
      nativeOpening: "origin",
      pageCapture: "disallowed",
      originActionLabel: "View on Nebula",
    },
    video: {
      nativeOpening: "origin",
      pageCapture: "disallowed",
      originActionLabel: "View on Nebula",
    },
  },
  leaflet: ATMOSPHERE_TEXT,
  pckt: ATMOSPHERE_TEXT,
  offprint: ATMOSPHERE_TEXT,
} as const satisfies Record<
  ContentPlatform,
  Record<ContentType, ContentCapability>
>;

export function getContentCapability(
  descriptor: ContentDescriptorKey,
): ContentCapability {
  return CONTENT_CAPABILITIES[descriptor.platform][descriptor.contentType];
}

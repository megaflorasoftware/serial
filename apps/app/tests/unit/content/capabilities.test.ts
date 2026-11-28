import { describe, expect, it } from "vitest";
import {
  canRetainPageCapture,
  CONTENT_CAPABILITIES,
  getNativeOpeningBehavior,
  getOriginActionLabel,
} from "~/lib/content/capabilities";
import {
  CONTENT_PLATFORM,
  CONTENT_PLATFORMS,
  CONTENT_TYPE,
  contentMediumOf,
  isTextPlatform,
  isVideoPlatform,
  itemDestinationOf,
  platformsOfMedium,
  TEXT_PLATFORMS,
  VIDEO_PLATFORMS,
} from "~/lib/content/descriptor";

const EXPECTED = [
  ["website", "text", "reader", true, "Open in Website"],
  ["website", "video", "origin", false, "Open in Website"],
  ["youtube", "text", "origin", false, "View on YouTube"],
  ["youtube", "video", "player", false, "View on YouTube"],
  ["peertube", "text", "origin", false, "View on PeerTube"],
  ["peertube", "video", "player", false, "View on PeerTube"],
  ["nebula", "text", "origin", false, "View on Nebula"],
  ["nebula", "video", "origin", false, "View on Nebula"],
  ["leaflet", "text", "reader", false, "Open in Website"],
  ["leaflet", "video", "origin", false, "Open in Website"],
  ["pckt", "text", "reader", false, "Open in Website"],
  ["pckt", "video", "origin", false, "Open in Website"],
  ["offprint", "text", "reader", false, "Open in Website"],
  ["offprint", "video", "origin", false, "Open in Website"],
] as const;

describe("content capabilities", () => {
  it("exhaustively defines every platform and content-type combination", () => {
    expect(Object.keys(CONTENT_CAPABILITIES).sort()).toEqual(
      Object.values(CONTENT_PLATFORM).sort(),
    );
    for (const platform of Object.values(CONTENT_PLATFORM)) {
      expect(Object.keys(CONTENT_CAPABILITIES[platform]).sort()).toEqual(
        Object.values(CONTENT_TYPE).sort(),
      );
    }
  });

  it.each(EXPECTED)(
    "%s × %s opens through %s, capture allowed=%s, action=%s",
    (platform, contentType, opening, captureAllowed, originActionLabel) => {
      const descriptor = { platform, contentType };
      expect(getNativeOpeningBehavior(descriptor)).toBe(opening);
      expect(canRetainPageCapture(descriptor)).toBe(captureAllowed);
      expect(getOriginActionLabel(descriptor)).toBe(originActionLabel);
    },
  );
});

describe("platform medium", () => {
  it("lists every platform under exactly one medium", () => {
    expect([...TEXT_PLATFORMS, ...VIDEO_PLATFORMS].sort()).toEqual(
      [...CONTENT_PLATFORMS].sort(),
    );
    expect(platformsOfMedium("text")).toEqual(TEXT_PLATFORMS);
    expect(platformsOfMedium("video")).toEqual(VIDEO_PLATFORMS);
  });

  it.each([
    ["website", "text"],
    ["leaflet", "text"],
    ["pckt", "text"],
    ["offprint", "text"],
    ["youtube", "video"],
    ["peertube", "video"],
    ["nebula", "video"],
  ] as const)("%s is a %s platform", (platform, medium) => {
    expect(contentMediumOf(platform)).toBe(medium);
    expect(isTextPlatform(platform)).toBe(medium === "text");
    expect(isVideoPlatform(platform)).toBe(medium === "video");
    expect(itemDestinationOf(platform)).toBe(
      medium === "text" ? "read" : "watch",
    );
  });

  it("reads an unknown stored platform as the website fallback", () => {
    expect(contentMediumOf("unknown")).toBe("text");
    expect(itemDestinationOf("unknown")).toBe("read");
  });

  it("opens text platforms in the reader without page capture, except website", () => {
    for (const platform of TEXT_PLATFORMS) {
      expect(getNativeOpeningBehavior({ platform, contentType: "text" })).toBe(
        "reader",
      );
      expect(canRetainPageCapture({ platform, contentType: "text" })).toBe(
        platform === CONTENT_PLATFORM.WEBSITE,
      );
    }
  });
});

import { describe, expect, it } from "vitest";
import { isChunkLoadError } from "~/lib/pwa/chunk-load-error";
import {
  hasAnyKey,
  shouldPreloadReaderChunk,
} from "~/lib/pwa/reader-chunk-preload";

describe("reader chunk preload gate", () => {
  it("preloads once offline content exists over a live connection", () => {
    expect(
      shouldPreloadReaderChunk({
        connectionState: "connected",
        hasOfflineContent: true,
        status: "idle",
      }),
    ).toBe(true);
  });

  it("never starts an import while disconnected or before the state is known", () => {
    for (const connectionState of ["disconnected", "unknown"] as const) {
      expect(
        shouldPreloadReaderChunk({
          connectionState,
          hasOfflineContent: true,
          status: "idle",
        }),
      ).toBe(false);
    }
  });

  it("waits for offline-readable content", () => {
    expect(
      shouldPreloadReaderChunk({
        connectionState: "connected",
        hasOfflineContent: false,
        status: "idle",
      }),
    ).toBe(false);
  });

  it("runs at most once per session", () => {
    for (const status of ["loading", "loaded"] as const) {
      expect(
        shouldPreloadReaderChunk({
          connectionState: "connected",
          hasOfflineContent: true,
          status,
        }),
      ).toBe(false);
    }
  });

  it("detects offline content from either retention store", () => {
    expect(hasAnyKey({})).toBe(false);
    expect(hasAnyKey({ "item-1": true })).toBe(true);
  });
});

describe("chunk load error detection", () => {
  it("recognizes every browser's failed dynamic import message", () => {
    for (const message of [
      "Importing a module script failed.",
      "Failed to fetch dynamically imported module: https://app/assets/x.js",
      "error loading dynamically imported module: https://app/assets/x.js",
      "Unable to preload CSS for /assets/_app.read-x.css",
    ]) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it("leaves ordinary render errors alone", () => {
    expect(isChunkLoadError(new TypeError("x is not a function"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: 42 })).toBe(false);
  });
});

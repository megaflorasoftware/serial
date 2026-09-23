import hljs from "highlight.js/lib/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canHighlightCode } from "~/components/content-reader/codeHighlightingPolicy";
import { highlightCode } from "~/components/content-reader/highlightCode";

afterEach(() => vi.restoreAllMocks());

describe("reader highlighting work bounds", () => {
  it("skips oversized, empty and explicitly plain code before tokenization", () => {
    const explicit = vi.spyOn(hljs, "highlight");
    const automatic = vi.spyOn(hljs, "highlightAuto");
    for (const [code, language] of [
      ["x".repeat(20_001), "js"],
      ["x".repeat(5_001), undefined],
      ["const x = 1", "text"],
      [" ", undefined],
    ] as const) {
      expect(canHighlightCode(code, language)).toBe(false);
      expect(highlightCode(code, language)).toBeNull();
    }
    expect(explicit).not.toHaveBeenCalled();
    expect(automatic).not.toHaveBeenCalled();
  });

  it("restricts detection to a fixed grammar set and leaves ambiguous prose plain", () => {
    const automatic = vi.spyOn(hljs, "highlightAuto");
    expect(highlightCode("hello world")).toBeNull();
    expect(automatic.mock.calls[0]?.[1]).toHaveLength(7);
    expect(highlightCode("const value = 42;\nconsole.log(value);")).toContain(
      "hljs",
    );
  });

  it("falls back when a grammar throws or a language is unavailable", () => {
    expect(highlightCode("unknown", "nonexistent")).toBeNull();
    vi.spyOn(hljs, "highlight").mockImplementation(() => {
      throw new Error("grammar failure");
    });
    expect(highlightCode("const x = 1;", "js")).toBeNull();
  });
});

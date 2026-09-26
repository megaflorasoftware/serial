import { describe, expect, it } from "vitest";
import {
  ADAPTER_REFERENCE_COLLECTIONS,
  adapterFor,
  BLOCK_NATIVE_CONTENT_TYPES,
  deriveResolvedContent,
  isBlockNativeContentType,
  PLATFORM_ADAPTERS,
  platformOfContentType,
} from "../src";
import { leaflet, offprint, pckt } from "./fixtures";

describe("platform adapter registry", () => {
  it("registers the three platform content types and nothing else", () => {
    expect(BLOCK_NATIVE_CONTENT_TYPES.sort()).toEqual([
      "app.offprint.content",
      "blog.pckt.content",
      "pub.leaflet.content",
    ]);
    expect(isBlockNativeContentType("at.markpub.markdown")).toBe(false);
    expect(isBlockNativeContentType(undefined)).toBe(false);
    expect(adapterFor({ $type: "at.markpub.markdown" })).toBeNull();
    expect(adapterFor("not an object")).toBeNull();
  });

  it("maps each content type to its platform and everything else to website", () => {
    for (const [type, adapter] of PLATFORM_ADAPTERS)
      expect(platformOfContentType(type)).toBe(adapter.platform);
    expect(platformOfContentType("pub.leaflet.content")).toBe("leaflet");
    expect(platformOfContentType("blog.pckt.content")).toBe("pckt");
    expect(platformOfContentType("app.offprint.content")).toBe("offprint");
    expect(platformOfContentType(null)).toBe("website");
    expect(platformOfContentType("at.markpub.markdown")).toBe("website");
  });

  it("lists the pckt gallery as the one adapter reference collection", () => {
    expect(ADAPTER_REFERENCE_COLLECTIONS).toEqual(["blog.pckt.gallery"]);
  });

  it("applies only the facet features a platform defines", () => {
    const did = "did:plc:example";
    const facets = [
      {
        index: { byteStart: 0, byteEnd: 4 },
        features: [{ $type: "x#underline" }, { $type: "x#footnote", contentPlaintext: "n" }],
      },
    ];
    const marksOf = (content: unknown) => {
      const document = deriveResolvedContent(content, did)!;
      const [paragraph] = document.blocks;
      if (paragraph?.kind !== "paragraph") throw new Error("no paragraph");
      return { inlines: paragraph.content, footnotes: document.footnotes };
    };
    // Leaflet and pckt define underline and footnotes.
    for (const content of [
      leaflet([{ $type: "pub.leaflet.blocks.text", plaintext: "text", facets }]),
      pckt([{ $type: "blog.pckt.block.text", plaintext: "text", facets }]),
    ]) {
      const { inlines, footnotes } = marksOf(content);
      expect(inlines[0]).toMatchObject({ marks: { underline: true } });
      expect(footnotes).toHaveLength(1);
    }
    // Offprint defines underline but no footnotes.
    const { inlines, footnotes } = marksOf(
      offprint([{ $type: "app.offprint.block.text", plaintext: "text", facets }]),
    );
    expect(inlines[0]).toMatchObject({ marks: { underline: true } });
    expect(inlines.some((inline) => inline.kind === "footnote")).toBe(false);
    expect(footnotes).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { layoutFootnotePositions } from "~/components/feed/read/footnoteLayout";

describe("layoutFootnotePositions", () => {
  it("keeps notes beside their references when they fit", () => {
    expect(
      layoutFootnotePositions({
        anchors: [100, 400],
        heights: [50, 50],
        limit: 1000,
        gap: 12,
      }),
    ).toEqual([100, 400]);
  });

  it("stacks a note below the previous one when references are close", () => {
    expect(
      layoutFootnotePositions({
        anchors: [100, 110],
        heights: [50, 50],
        limit: 1000,
        gap: 12,
      }),
    ).toEqual([100, 162]);
  });

  it("pushes a tall final note up so it ends inside the pane", () => {
    expect(
      layoutFootnotePositions({
        anchors: [100, 900],
        heights: [50, 300],
        limit: 1000,
        gap: 12,
      }),
    ).toEqual([100, 700]);
  });

  it("pushes the chain above an overflowing note upward too", () => {
    const positions = layoutFootnotePositions({
      anchors: [100, 850, 900],
      heights: [50, 100, 300],
      limit: 1000,
      gap: 12,
    });
    expect(positions).toEqual([100, 588, 700]);
  });

  it("overflows from the bottom only when notes outgrow the pane", () => {
    expect(
      layoutFootnotePositions({
        anchors: [0, 10],
        heights: [300, 300],
        limit: 500,
        gap: 12,
      }),
    ).toEqual([0, 312]);
  });

  it("skips the upward pass when the pane height is unknown", () => {
    expect(
      layoutFootnotePositions({
        anchors: [900],
        heights: [300],
        limit: 0,
        gap: 12,
      }),
    ).toEqual([900]);
  });
});

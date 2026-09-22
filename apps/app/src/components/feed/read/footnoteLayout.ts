export type FootnoteLayoutInput = {
  /** Offset of each footnote's first reference from the top of the pane. */
  anchors: number[];
  /** Rendered height of each footnote card, in the same order as anchors. */
  heights: number[];
  /** Height of the pane the cards must stay within. */
  limit: number;
  /** Vertical gap kept between stacked cards. */
  gap: number;
};

/**
 * Places footnote cards beside their references without overlap.
 *
 * Cards first stack downward from their references. Any card that would end
 * below the pane then pushes the chain above it upward, so a long note near
 * the end of a document sits beside earlier text instead of running past the
 * bottom. Only when the notes outgrow the pane altogether do they overflow,
 * and then from the bottom rather than above the document.
 */
export function layoutFootnotePositions({
  anchors,
  heights,
  limit,
  gap,
}: FootnoteLayoutInput): number[] {
  const positions: number[] = [];
  let previousBottom = 0;
  for (const [index, anchor] of anchors.entries()) {
    const top = Math.max(anchor, previousBottom);
    positions.push(top);
    previousBottom = top + (heights[index] ?? 0) + gap;
  }

  if (limit <= 0) return positions;

  let nextTop = limit;
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const top = Math.min(positions[index]!, nextTop - (heights[index] ?? 0));
    positions[index] = top;
    nextTop = top - gap;
  }

  const overshoot = positions[0] ?? 0;
  if (overshoot < 0) {
    for (let index = 0; index < positions.length; index += 1) {
      positions[index]! -= overshoot;
    }
  }

  return positions;
}

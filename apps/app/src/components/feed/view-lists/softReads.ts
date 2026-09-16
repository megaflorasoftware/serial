import type { ViewSection } from "./useViewSections";

export type SoftReadPosition = { sectionKey: string; index: number };

export function softReadSectionKey(section: ViewSection) {
  return section.isUncategorized
    ? "uncategorized"
    : `${section.itemType}:${section.itemId}`;
}

/** Restore individually toggled items without freezing new pages or other removals. */
export function retainSoftReadPositions(
  sections: ViewSection[],
  positions: ReadonlyMap<string, SoftReadPosition>,
): ViewSection[] {
  if (positions.size === 0) return sections;

  const retainedBySection = new Map<string, Array<[string, number]>>();
  for (const [id, position] of positions) {
    const entries = retainedBySection.get(position.sectionKey) ?? [];
    entries.push([id, position.index]);
    retainedBySection.set(position.sectionKey, entries);
  }

  let startIndex = 0;
  return sections.map((section) => {
    const retained = retainedBySection.get(softReadSectionKey(section)) ?? [];
    retained.sort((left, right) => left[1] - right[1]);
    const liveItems = section.items.filter((id) => !positions.has(id));
    const items: string[] = [];
    let liveIndex = 0;
    for (const [id, index] of retained) {
      while (items.length < index && liveIndex < liveItems.length) {
        items.push(liveItems[liveIndex++]!);
      }
      items.push(id);
    }
    items.push(...liveItems.slice(liveIndex));
    const result = { ...section, items, startIndex };
    startIndex += items.length;
    return result;
  });
}

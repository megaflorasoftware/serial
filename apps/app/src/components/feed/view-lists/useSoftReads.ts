import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { retainSoftReadPositions, softReadSectionKey } from "./softReads";
import type { SoftReadPosition } from "./softReads";
import type { ViewSection } from "./useViewSections";
import { contentStatusFilterAtom } from "~/lib/data/atoms";
import { bookmarksStore } from "~/lib/data/bookmarks/store";
import { feedItemsStore, useFeedItemsListProjection } from "~/lib/data/store";
import {
  clearRetainedEntityPins,
  setRetainedEntityPins,
} from "~/lib/data/page-retention";

export function useSoftReads(sections: ViewSection[]) {
  const { saveStatus } = useAtomValue(contentStatusFilterAtom);
  const owner = useId();
  const [positions, setPositions] = useState(
    new Map<string, SoftReadPosition>(),
  );
  const feedItems = useFeedItemsListProjection();
  const bookmarkRevision = bookmarksStore.useRevision();
  const activePositions = useMemo(() => {
    void bookmarkRevision;
    return new Map(
      [...positions].filter(([id]) => {
        const bookmark = bookmarksStore.getState().getBookmark(id);
        return bookmark
          ? bookmark.isSaved
          : feedItems.getItems()[id]?.isWatchLater === true;
      }),
    );
  }, [positions, feedItems, bookmarkRevision]);
  const retainedSections = useMemo(
    () => retainSoftReadPositions(sections, activePositions),
    [sections, activePositions],
  );

  const pinPositions = useCallback(
    (nextPositions: ReadonlyMap<string, SoftReadPosition>) => {
      const bookmarkIds: string[] = [];
      const feedItemIds: string[] = [];
      for (const id of nextPositions.keys()) {
        if (bookmarksStore.getState().getBookmark(id)) bookmarkIds.push(id);
        else if (feedItemsStore.getState().feedItemsDict[id])
          feedItemIds.push(id);
      }
      setRetainedEntityPins(owner, { bookmarkIds, feedItemIds });
    },
    [owner],
  );

  if (activePositions.size !== positions.size) setPositions(activePositions);
  useEffect(
    () => pinPositions(activePositions),
    [activePositions, pinPositions],
  );
  useEffect(() => () => clearRetainedEntityPins(owner), [owner]);

  const toggleRead = useCallback(
    (id: string, mutate: () => boolean) => {
      if (saveStatus !== "saved" || activePositions.has(id)) return mutate();
      const section = retainedSections.find((candidate) =>
        candidate.items.includes(id),
      );
      if (!section) return mutate();
      const nextPositions = new Map(activePositions);
      nextPositions.set(id, {
        sectionKey: softReadSectionKey(section),
        index: section.items.indexOf(id),
      });
      // Pin before the optimistic mutation can remove the last page reference.
      pinPositions(nextPositions);
      try {
        if (!mutate()) {
          pinPositions(activePositions);
          return false;
        }
      } catch (error) {
        pinPositions(activePositions);
        throw error;
      }
      setPositions(nextPositions);
      return true;
    },
    [activePositions, pinPositions, retainedSections, saveStatus],
  );

  return { sections: retainedSections, toggleRead };
}

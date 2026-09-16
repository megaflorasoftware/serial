import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import {
  getEligibleSoftReadIds,
  retainEligibleSoftReadPositions,
  retainSoftReadPositions,
  softReadSectionKey,
} from "./softReads";
import type { SoftReadPosition } from "./softReads";
import { useViewSections } from "./useViewSections";
import type { ViewSection } from "./useViewSections";
import type { ApplicationView } from "~/server/db/schema";
import {
  categoryFilterAtom,
  contentStatusFilterAtom,
  feedFilterAtom,
} from "~/lib/data/atoms";
import { bookmarksStore } from "~/lib/data/bookmarks/store";
import { useFeedCategories } from "~/lib/data/feed-categories";
import { feedItemsStore, useFeedItemsListProjection } from "~/lib/data/store";
import { useViews } from "~/lib/data/views";
import {
  clearRetainedEntityPins,
  setRetainedEntityPins,
} from "~/lib/data/page-retention";

export function useSoftReads(
  sections: ViewSection[],
  currentView: ApplicationView | null,
) {
  const contentStatusFilter = useAtomValue(contentStatusFilterAtom);
  const { saveStatus } = contentStatusFilter;
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const feedFilter = useAtomValue(feedFilterAtom);
  const owner = useId();
  const [positions, setPositions] = useState(
    new Map<string, SoftReadPosition>(),
  );
  const feedItems = useFeedItemsListProjection();
  const { feedCategories } = useFeedCategories();
  const { views } = useViews();
  const bookmarkRevision = bookmarksStore.useRevision();
  const eligibleIds = useMemo(() => {
    void bookmarkRevision;
    return getEligibleSoftReadIds({
      positions,
      bookmarksById: bookmarksStore.getState().snapshot(),
      feedItemsById: feedItems.getItems(),
      feedCategories,
      views,
      currentView,
      categoryFilter,
      feedFilter,
      saveStatus,
    });
  }, [
    bookmarkRevision,
    categoryFilter,
    currentView,
    feedFilter,
    feedCategories,
    feedItems,
    positions,
    saveStatus,
    views,
  ]);
  const { computedSections: eligibleSections } = useViewSections(
    currentView,
    eligibleIds,
  );
  const activePositions = useMemo(
    () => retainEligibleSoftReadPositions(positions, eligibleSections),
    [positions, eligibleSections],
  );
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

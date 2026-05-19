"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useLocation } from "@tanstack/react-router";
import { useShortcut } from "./useShortcut";
import { useFeedItemActions } from "./useFeedItemActions";
import { useLoadMoreItems } from "./useLoadMoreItems";
import type { KeyboardEvent } from "react";
import {
  categoryFilterAtom,
  feedFilterAtom,
  isReturningFromRouteAtom,
  selectedItemIdAtom,
  softReadItemIdsAtom,
  viewFilterIdAtom,
} from "~/lib/data/atoms";
import {
  getShortcutAllowRepeat,
  getShortcutKey,
  SHORTCUT_KEYS,
} from "~/lib/constants/shortcuts";
import { getScrollContainer } from "~/lib/scroll";
import {
  useSaveToInstapaperMutation,
  useShowInstapaperAction,
} from "~/lib/data/instapaper";

const SCROLL_DURATION_MS = 300;
const TARGET_VIEWPORT_POSITION = 1 / 3;

interface SectionInfo {
  size: number;
  isGrid: boolean;
}

function isElementInViewport(element: Element): boolean {
  const container = getScrollContainer();
  const containerRect = container.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.top < containerRect.bottom && rect.bottom > containerRect.top;
}

function getClosestVisibleItem(items: string[]): string | null {
  const container = getScrollContainer();
  const containerRect = container.getBoundingClientRect();
  const viewportTarget =
    containerRect.top + containerRect.height * TARGET_VIEWPORT_POSITION;
  let closestItem: string | null = null;
  let closestDistance = Infinity;

  for (const itemId of items) {
    const element = document.querySelector(`[data-item-id="${itemId}"]`);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom)
      continue;

    const elementCenter = rect.top + rect.height / 2;
    const distance = Math.abs(elementCenter - viewportTarget);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = itemId;
    }
  }

  return closestItem;
}

function getGridColumns(items: string[]): number {
  if (items.length < 2) return 1;

  const firstElement = document.querySelector(`[data-item-id="${items[0]}"]`);
  if (!firstElement) return 1;

  const firstRect = firstElement.getBoundingClientRect();
  const firstTop = Math.round(firstRect.top);

  for (let i = 1; i < items.length; i++) {
    const element = document.querySelector(`[data-item-id="${items[i]}"]`);
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    if (Math.round(rect.top) !== firstTop) {
      return i;
    }
  }

  return items.length;
}

function getGridPosition(
  items: string[],
  selectedItemId: string,
): { row: number; col: number; columns: number } | null {
  const index = items.indexOf(selectedItemId);
  if (index === -1) return null;

  const columns = getGridColumns(items);
  const row = Math.floor(index / columns);
  const col = index % columns;

  return { row, col, columns };
}

function buildSectionBoundaries(sections: SectionInfo[]) {
  const boundaries: Array<{ start: number; end: number; isGrid: boolean }> = [];
  let start = 0;
  for (const section of sections) {
    boundaries.push({
      start,
      end: start + section.size,
      isGrid: section.isGrid,
    });
    start += section.size;
  }
  return boundaries;
}

function getSectionIndex(
  itemIndex: number,
  boundaries: Array<{ start: number; end: number }>,
): number {
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    if (itemIndex >= b.start && itemIndex < b.end) {
      return i;
    }
  }
  return boundaries.length - 1;
}

export function useFeedItemNavigation(
  items: string[],
  isGridLayout: boolean = false,
  sections?: SectionInfo[],
) {
  const [selectedItemId, setSelectedItemId] = useAtom(selectedItemIdAtom);
  const setSoftReadItemIds = useSetAtom(softReadItemIdsAtom);
  const [isReturningFromRoute, setIsReturningFromRoute] = useAtom(
    isReturningFromRouteAtom,
  );
  const viewFilterId = useAtomValue(viewFilterIdAtom);
  const categoryFilter = useAtomValue(categoryFilterAtom);
  const feedFilter = useAtomValue(feedFilterAtom);
  const { pathname } = useLocation();

  const prevViewFilterIdRef = useRef<number | null>(null);
  const prevCategoryFilterRef = useRef<number | null>(null);
  const prevFeedFilterRef = useRef<number | null>(null);
  const keyboardNavActiveRef = useRef(false);
  const lastNavTimeRef = useRef<number>(0);

  const selectedItemActions = useFeedItemActions(selectedItemId ?? "");
  const showInstapaperAction = useShowInstapaperAction(selectedItemId ?? "");
  const { mutateAsync: saveToInstapaper } = useSaveToInstapaperMutation(
    selectedItemId ?? "",
  );
  const { handleLoadMore } = useLoadMoreItems();

  const hasSections = sections && sections.length > 0;
  const sectionBoundaries = useMemo(() => {
    if (!hasSections) return [];
    return buildSectionBoundaries(sections);
  }, [hasSections, sections]);

  const scrollToItem = useCallback(
    (itemId: string | null, forceInstant: boolean = false) => {
      if (!itemId) return;
      const element = document.querySelector(`[data-item-id="${itemId}"]`);
      if (!element) return;

      const container = getScrollContainer();
      const containerRect = container.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const targetPosition = containerRect.height * TARGET_VIEWPORT_POSITION;
      const scrollTop =
        container.scrollTop +
        (rect.top - containerRect.top) -
        targetPosition +
        rect.height / 2;

      const now = performance.now();
      const isRapid = now - lastNavTimeRef.current < SCROLL_DURATION_MS;
      lastNavTimeRef.current = now;

      if (forceInstant || isRapid) {
        container.scrollTo({ top: scrollTop, behavior: "instant" });
        return;
      }

      container.scrollTo({ top: scrollTop, behavior: "smooth" });
    },
    [],
  );

  const selectItem = useCallback(
    (itemId: string | null, forceInstant: boolean = false) => {
      keyboardNavActiveRef.current = true;
      setSelectedItemId(itemId);
      scrollToItem(itemId, forceInstant);
    },
    [setSelectedItemId, scrollToItem],
  );

  const selectNextItem = useCallback(
    (currentIndex: number) => {
      const nextIndex = currentIndex + 1;
      if (nextIndex < items.length) {
        selectItem(items[nextIndex]!);
      } else if (currentIndex > 0) {
        selectItem(items[currentIndex - 1]!);
      } else {
        selectItem(null);
      }
    },
    [items, selectItem],
  );

  const handleArrowDown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/") return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;

      if (currentIndex === -1) {
        if (getScrollContainer().scrollTop === 0 && items.length > 0) {
          selectItem(items[0]!);
        } else {
          const closestItem = getClosestVisibleItem(items);
          if (closestItem) {
            selectItem(closestItem);
          } else if (items.length > 0) {
            selectItem(items[0]!);
          }
        }
        return;
      }

      const selectedElement = document.querySelector(
        `[data-item-id="${selectedItemId}"]`,
      );
      if (selectedElement && !isElementInViewport(selectedElement)) {
        const closestItem = getClosestVisibleItem(items);
        if (closestItem) {
          selectItem(closestItem);
        }
        return;
      }

      const isGrid =
        isGridLayout ||
        (hasSections &&
          sectionBoundaries[getSectionIndex(currentIndex, sectionBoundaries)]
            ?.isGrid);

      if (isGrid && selectedItemId) {
        const gridPos = getGridPosition(items, selectedItemId);
        if (gridPos) {
          const nextIndex = (gridPos.row + 1) * gridPos.columns + gridPos.col;
          if (nextIndex < items.length) {
            // Check if we've moved to a different section
            if (hasSections) {
              const currentSection = getSectionIndex(
                currentIndex,
                sectionBoundaries,
              );
              const nextSection = getSectionIndex(nextIndex, sectionBoundaries);
              if (currentSection !== nextSection) {
                // Jump to first item of next section
                const nextSectionStart =
                  sectionBoundaries[nextSection]?.start ?? nextIndex;
                selectItem(items[nextSectionStart]!);
                return;
              }
            }
            selectItem(items[nextIndex]!);
          } else {
            // At the end of the grid, try next section
            if (hasSections) {
              const currentSection = getSectionIndex(
                currentIndex,
                sectionBoundaries,
              );
              const nextSection = currentSection + 1;
              if (nextSection < sectionBoundaries.length) {
                const nextSectionStart = sectionBoundaries[nextSection]!.start;
                selectItem(items[nextSectionStart]!);
                return;
              }
            }
            setSelectedItemId(null);
            getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
          }
        }
      } else {
        const nextIndex = currentIndex + 1;
        if (nextIndex >= items.length) {
          setSelectedItemId(null);
          getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
        } else {
          // Check if we've crossed a section boundary
          if (hasSections) {
            const currentSection = getSectionIndex(
              currentIndex,
              sectionBoundaries,
            );
            const nextSection = getSectionIndex(nextIndex, sectionBoundaries);
            if (currentSection !== nextSection) {
              // Jump to first item of next section
              const nextSectionStart = sectionBoundaries[nextSection]!.start;
              selectItem(items[nextSectionStart]!);
              return;
            }
          }
          selectItem(items[nextIndex]!);
        }
      }
    },
    [
      pathname,
      selectedItemId,
      items,
      selectItem,
      isGridLayout,
      setSelectedItemId,
      hasSections,
      sectionBoundaries,
    ],
  );

  const handleArrowUp = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/") return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;

      if (currentIndex === -1) {
        if (getScrollContainer().scrollTop === 0 && items.length > 0) {
          selectItem(items[items.length - 1]!, true);
          handleLoadMore();
        } else {
          const closestItem = getClosestVisibleItem(items);
          if (closestItem) {
            selectItem(closestItem);
          } else if (items.length > 0) {
            selectItem(items[items.length - 1]!, true);
          }
        }
        return;
      }

      const selectedElement = document.querySelector(
        `[data-item-id="${selectedItemId}"]`,
      );
      if (selectedElement && !isElementInViewport(selectedElement)) {
        const closestItem = getClosestVisibleItem(items);
        if (closestItem) {
          selectItem(closestItem);
        }
        return;
      }

      const isGrid =
        isGridLayout ||
        (hasSections &&
          sectionBoundaries[getSectionIndex(currentIndex, sectionBoundaries)]
            ?.isGrid);

      if (isGrid && selectedItemId) {
        const gridPos = getGridPosition(items, selectedItemId);
        if (gridPos && gridPos.row > 0) {
          const prevIndex = (gridPos.row - 1) * gridPos.columns + gridPos.col;
          // Check if we've moved to a different section
          if (hasSections) {
            const currentSection = getSectionIndex(
              currentIndex,
              sectionBoundaries,
            );
            const prevSection = getSectionIndex(prevIndex, sectionBoundaries);
            if (currentSection !== prevSection) {
              // Jump to last item of previous section
              const prevSectionEnd = sectionBoundaries[prevSection]!.end - 1;
              selectItem(items[prevSectionEnd]!);
              return;
            }
          }
          selectItem(items[prevIndex]!);
        } else {
          // At the top of the grid, try previous section
          if (hasSections) {
            const currentSection = getSectionIndex(
              currentIndex,
              sectionBoundaries,
            );
            const prevSection = currentSection - 1;
            if (prevSection >= 0) {
              const prevSectionEnd = sectionBoundaries[prevSection]!.end - 1;
              selectItem(items[prevSectionEnd]!);
              return;
            }
          }
          setSelectedItemId(null);
          getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
        }
      } else if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        // Check if we've crossed a section boundary
        if (hasSections) {
          const currentSection = getSectionIndex(
            currentIndex,
            sectionBoundaries,
          );
          const prevSection = getSectionIndex(prevIndex, sectionBoundaries);
          if (currentSection !== prevSection) {
            // Jump to last item of previous section
            const prevSectionEnd = sectionBoundaries[prevSection]!.end - 1;
            selectItem(items[prevSectionEnd]!);
            return;
          }
        }
        selectItem(items[prevIndex]!);
      } else {
        setSelectedItemId(null);
        getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
      }
    },
    [
      pathname,
      selectedItemId,
      items,
      selectItem,
      isGridLayout,
      setSelectedItemId,
      handleLoadMore,
      hasSections,
      sectionBoundaries,
    ],
  );

  const handleArrowRight = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/" || (!isGridLayout && !hasSections)) return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;
      if (currentIndex === -1) {
        if (items.length > 0) selectItem(items[0]!);
        return;
      }

      const nextIndex = currentIndex + 1;
      if (nextIndex < items.length) {
        // Check if we've crossed a section boundary into a grid section
        if (hasSections) {
          const currentSection = getSectionIndex(
            currentIndex,
            sectionBoundaries,
          );
          const nextSection = getSectionIndex(nextIndex, sectionBoundaries);
          if (currentSection !== nextSection) {
            // Jump to first item of next section
            const nextSectionStart = sectionBoundaries[nextSection]!.start;
            selectItem(items[nextSectionStart]!);
            return;
          }
        }
        selectItem(items[nextIndex]!);
      } else if (hasSections) {
        // At end, jump to first item of next section
        const currentSection = getSectionIndex(currentIndex, sectionBoundaries);
        const nextSection = currentSection + 1;
        if (nextSection < sectionBoundaries.length) {
          const nextSectionStart = sectionBoundaries[nextSection]!.start;
          selectItem(items[nextSectionStart]!);
        }
      }
    },
    [
      pathname,
      selectedItemId,
      items,
      selectItem,
      isGridLayout,
      hasSections,
      sectionBoundaries,
    ],
  );

  const handleArrowLeft = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/" || (!isGridLayout && !hasSections)) return;

      const currentIndex = selectedItemId ? items.indexOf(selectedItemId) : -1;
      if (currentIndex === -1) {
        if (items.length > 0) selectItem(items[0]!);
        return;
      }

      if (currentIndex > 0) {
        const prevIndex = currentIndex - 1;
        // Check if we've crossed a section boundary
        if (hasSections) {
          const currentSection = getSectionIndex(
            currentIndex,
            sectionBoundaries,
          );
          const prevSection = getSectionIndex(prevIndex, sectionBoundaries);
          if (currentSection !== prevSection) {
            // Jump to last item of previous section
            const prevSectionEnd = sectionBoundaries[prevSection]!.end - 1;
            selectItem(items[prevSectionEnd]!);
            return;
          }
        }
        selectItem(items[prevIndex]!);
      } else if (hasSections) {
        // At start, jump to last item of previous section
        const currentSection = getSectionIndex(currentIndex, sectionBoundaries);
        const prevSection = currentSection - 1;
        if (prevSection >= 0) {
          const prevSectionEnd = sectionBoundaries[prevSection]!.end - 1;
          selectItem(items[prevSectionEnd]!);
        }
      }
    },
    [
      pathname,
      selectedItemId,
      items,
      selectItem,
      isGridLayout,
      hasSections,
      sectionBoundaries,
    ],
  );

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_DOWN), handleArrowDown, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_DOWN),
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_UP), handleArrowUp, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_UP),
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_RIGHT), handleArrowRight, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_RIGHT),
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_LEFT), handleArrowLeft, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_LEFT),
  });

  const handleToggleRead = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (pathname !== "/" || !selectedItemId) return;

      const idx = items.indexOf(selectedItemId);
      const wasMarkedRead = selectedItemActions.toggleRead();
      if (wasMarkedRead) {
        if (idx === items.length - 1) {
          setSelectedItemId(null);
          getScrollContainer().scrollTo({ top: 0, behavior: "smooth" });
        } else {
          selectNextItem(idx);
        }
      }
    },
    [
      pathname,
      selectedItemId,
      selectedItemActions,
      items,
      selectNextItem,
      setSelectedItemId,
    ],
  );

  useShortcut(getShortcutKey(SHORTCUT_KEYS.TOGGLE_READ), handleToggleRead);

  useShortcut(getShortcutKey(SHORTCUT_KEYS.TOGGLE_READ_ALT), handleToggleRead);

  useShortcut(getShortcutKey(SHORTCUT_KEYS.TOGGLE_LATER), () => {
    if (pathname !== "/" || !selectedItemId) return;

    selectedItemActions.toggleWatchLater();
    const idx = items.indexOf(selectedItemId);
    selectNextItem(idx);
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ENTER), () => {
    if (pathname !== "/" || !selectedItemId) return;

    selectedItemActions.openItem();
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.SEND_TO_INSTAPAPER), () => {
    if (pathname !== "/" || !selectedItemId || !showInstapaperAction) return;

    void saveToInstapaper({ feedItemId: selectedItemId });
    const idx = items.indexOf(selectedItemId);
    selectNextItem(idx);
  });

  useEffect(() => {
    if (viewFilterId === null) return;

    const viewChanged =
      prevViewFilterIdRef.current !== null &&
      prevViewFilterIdRef.current !== viewFilterId;
    const categoryChanged =
      prevCategoryFilterRef.current !== null &&
      prevCategoryFilterRef.current !== categoryFilter;
    const feedChanged =
      prevFeedFilterRef.current !== null &&
      prevFeedFilterRef.current !== feedFilter;

    if (viewChanged || categoryChanged || feedChanged) {
      setSoftReadItemIds(new Set());
      setSelectedItemId(null);
      getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
    }

    prevViewFilterIdRef.current = viewFilterId;
    prevCategoryFilterRef.current = categoryFilter;
    prevFeedFilterRef.current = feedFilter;
  }, [
    viewFilterId,
    categoryFilter,
    feedFilter,
    setSoftReadItemIds,
    setSelectedItemId,
  ]);

  useEffect(() => {
    if (pathname !== "/") {
      setIsReturningFromRoute(true);
      return;
    }

    if (isReturningFromRoute && selectedItemId) {
      setIsReturningFromRoute(false);
      scrollToItem(selectedItemId, true);
    }
  }, [
    pathname,
    selectedItemId,
    isReturningFromRoute,
    setIsReturningFromRoute,
    scrollToItem,
  ]);

  useEffect(() => {
    const handleMouseMove = () => {
      keyboardNavActiveRef.current = false;
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  const handleMouseSelect = useCallback(
    (itemId: string) => {
      if (keyboardNavActiveRef.current) return;
      setSelectedItemId(itemId);
    },
    [setSelectedItemId],
  );

  return { selectedItemId, handleMouseSelect };
}

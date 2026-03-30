"use client";

import { useCallback, useRef, useState } from "react";
import { atom, useSetAtom } from "jotai";
import { useShortcut } from "./useShortcut";
import type { KeyboardEvent, RefObject } from "react";
import {
  getShortcutAllowRepeat,
  getShortcutKey,
  SHORTCUT_KEYS,
} from "~/lib/constants/shortcuts";

export const articleSelectedElementAtom = atom<HTMLElement | null>(null);

const SCROLL_DURATION_MS = 300;
const TARGET_VIEWPORT_POSITION = 1 / 3;
const SELECTABLE =
  ":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > blockquote, :scope > img, :scope > figure, :scope > div";

function getElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(SELECTABLE)).filter(
    (el) =>
      el.textContent?.trim() || el.tagName === "IMG" || el.tagName === "FIGURE",
  );
}

function isElementInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom > 0;
}

function getClosestVisibleElement(elements: HTMLElement[]): number {
  const viewportTarget = window.innerHeight * TARGET_VIEWPORT_POSITION;
  let closestIndex = -1;
  let closestDistance = Infinity;

  for (let i = 0; i < elements.length; i++) {
    const rect = elements[i]!.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

    const elementCenter = rect.top + rect.height / 2;
    const distance = Math.abs(elementCenter - viewportTarget);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }

  return closestIndex;
}

export function useArticleNavigation(
  containerRef: RefObject<HTMLElement | null>,
) {
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const lastNavTimeRef = useRef<number>(0);
  const prevSelectedRef = useRef<HTMLElement | null>(null);
  const setArticleSelectedElement = useSetAtom(articleSelectedElementAtom);

  const applySelection = useCallback(
    (elements: HTMLElement[], index: number) => {
      // Remove previous selection
      if (prevSelectedRef.current) {
        prevSelectedRef.current.removeAttribute("data-article-selected");
      }

      if (index >= 0 && index < elements.length) {
        const el = elements[index]!;
        el.setAttribute("data-article-selected", "true");
        prevSelectedRef.current = el;
        setArticleSelectedElement(el);
      } else {
        prevSelectedRef.current = null;
        setArticleSelectedElement(null);
      }
    },
    [setArticleSelectedElement],
  );

  const scrollToElement = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const targetPosition = window.innerHeight * TARGET_VIEWPORT_POSITION;
    const scrollTop =
      window.scrollY + rect.top - targetPosition + rect.height / 2;

    const now = performance.now();
    const isRapid = now - lastNavTimeRef.current < SCROLL_DURATION_MS;
    lastNavTimeRef.current = now;

    window.scrollTo({
      top: scrollTop,
      behavior: isRapid ? "instant" : "smooth",
    });
  }, []);

  const selectElement = useCallback(
    (elements: HTMLElement[], index: number) => {
      setSelectedIndex(index);
      applySelection(elements, index);
      if (index >= 0 && index < elements.length) {
        scrollToElement(elements[index]!);
      }
    },
    [applySelection, scrollToElement],
  );

  const handleArrowDown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      const elements = getElements(containerRef.current);
      if (elements.length === 0) return;

      if (selectedIndex === -1) {
        // No selection: pick closest visible or first
        if (window.scrollY === 0) {
          selectElement(elements, 0);
        } else {
          const closest = getClosestVisibleElement(elements);
          selectElement(elements, closest >= 0 ? closest : 0);
        }
        return;
      }

      // If selected element is off-screen, snap to closest visible
      const selectedEl = elements[selectedIndex];
      if (selectedEl && !isElementInViewport(selectedEl)) {
        const closest = getClosestVisibleElement(elements);
        if (closest >= 0) {
          selectElement(elements, closest);
          return;
        }
      }

      // Move to next, loop to first
      const nextIndex = selectedIndex + 1;
      selectElement(elements, nextIndex < elements.length ? nextIndex : 0);
    },
    [containerRef, selectedIndex, selectElement],
  );

  const handleArrowUp = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      const elements = getElements(containerRef.current);
      if (elements.length === 0) return;

      if (selectedIndex === -1) {
        if (window.scrollY === 0) {
          selectElement(elements, 0);
        } else {
          const closest = getClosestVisibleElement(elements);
          selectElement(elements, closest >= 0 ? closest : 0);
        }
        return;
      }

      // If selected element is off-screen, snap to closest visible
      const selectedEl = elements[selectedIndex];
      if (selectedEl && !isElementInViewport(selectedEl)) {
        const closest = getClosestVisibleElement(elements);
        if (closest >= 0) {
          selectElement(elements, closest);
          return;
        }
      }

      // Move to previous, loop to last
      selectElement(
        elements,
        selectedIndex > 0 ? selectedIndex - 1 : elements.length - 1,
      );
    },
    [containerRef, selectedIndex, selectElement],
  );

  const handleSpace = useCallback((event: KeyboardEvent) => {
    event.preventDefault();
  }, []);

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_DOWN), handleArrowDown, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_DOWN),
  });

  useShortcut(getShortcutKey(SHORTCUT_KEYS.ARROW_UP), handleArrowUp, {
    allowRepeat: getShortcutAllowRepeat(SHORTCUT_KEYS.ARROW_UP),
  });

  useShortcut(" ", handleSpace);
}

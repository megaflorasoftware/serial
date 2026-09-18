"use client";

import { useLayoutEffect, useRef } from "react";
import { getElements } from "./useArticleNavigation";
import { getShortcutKeys, SHORTCUT_KEYS } from "~/lib/constants/shortcuts";
import { getScrollContainer } from "~/lib/scroll";
import {
  scrollArticleBlockToTarget,
  setArticleRestorationVisibility,
} from "~/lib/article-block-scroll";

const READER_SCROLL_KEYS = new Set([
  ...getShortcutKeys(SHORTCUT_KEYS.ARROW_UP),
  ...getShortcutKeys(SHORTCUT_KEYS.ARROW_DOWN),
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

export function useRestoreArticleProgress({
  contentId,
  articleElement,
  progress,
  ready = true,
}: {
  contentId: string;
  articleElement: HTMLElement | null;
  progress: number | undefined;
  ready?: boolean;
}) {
  const restoredContentIdRef = useRef<string | null>(null);
  const hasUserInteractedRef = useRef(false);

  useLayoutEffect(() => {
    hasUserInteractedRef.current = false;
    const container = getScrollContainer();
    const markUserInteraction = () => {
      hasUserInteractedRef.current = true;
      if (articleElement) setArticleRestorationVisibility(articleElement, true);
    };
    const handleKeydown = (event: KeyboardEvent) => {
      if (READER_SCROLL_KEYS.has(event.key)) markUserInteraction();
    };

    container.addEventListener("wheel", markUserInteraction, { passive: true });
    container.addEventListener("pointerdown", markUserInteraction, {
      passive: true,
    });
    container.addEventListener("touchstart", markUserInteraction, {
      passive: true,
    });
    window.addEventListener("keydown", handleKeydown);

    return () => {
      container.removeEventListener("wheel", markUserInteraction);
      container.removeEventListener("pointerdown", markUserInteraction);
      container.removeEventListener("touchstart", markUserInteraction);
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [articleElement, contentId]);

  useLayoutEffect(() => {
    if (!articleElement) {
      return;
    }
    if (
      restoredContentIdRef.current === contentId ||
      hasUserInteractedRef.current
    ) {
      setArticleRestorationVisibility(articleElement, true);
      return;
    }

    setArticleRestorationVisibility(articleElement, false);
    if (!ready || progress === undefined) {
      return () => {
        setArticleRestorationVisibility(articleElement, true);
      };
    }

    const savedProgress = progress;
    const contentElement = articleElement;

    function revealContent() {
      setArticleRestorationVisibility(contentElement, true);
    }

    let firstFrame = 0;
    let secondFrame = 0;
    const observer = new MutationObserver(() => scheduleRestore());

    function completeRestoration(element?: HTMLElement) {
      restoredContentIdRef.current = contentId;
      observer.disconnect();
      if (element) scrollArticleBlockToTarget(element, "instant");
      else getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
      revealContent();
    }

    function scheduleRestore() {
      if (
        firstFrame ||
        restoredContentIdRef.current === contentId ||
        hasUserInteractedRef.current
      ) {
        return;
      }
      const elements = getElements(contentElement);
      if (contentElement.querySelector("[data-reader-content-pending]")) {
        return;
      }

      if (elements.length === 0 || savedProgress <= 0) {
        completeRestoration();
        return;
      }

      firstFrame = requestAnimationFrame(() => {
        firstFrame = 0;
        secondFrame = requestAnimationFrame(() => {
          secondFrame = 0;
          if (hasUserInteractedRef.current) return;
          const renderedElements = getElements(contentElement);
          if (contentElement.querySelector("[data-reader-content-pending]")) {
            return;
          }

          completeRestoration(
            renderedElements[
              Math.min(savedProgress, renderedElements.length - 1)
            ],
          );
        });
      });
    }

    observer.observe(contentElement, { childList: true, subtree: true });
    scheduleRestore();

    return () => {
      observer.disconnect();
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      revealContent();
    };
  }, [articleElement, contentId, progress, ready]);
}

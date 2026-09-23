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

/** A body placeholder is on screen; there is nothing to place yet. */
function hasPendingContent(article: HTMLElement) {
  return !!article.querySelector("[data-reader-content-pending]");
}

/**
 * Places the reader at its saved progress. Content already on the client is
 * placed and revealed at once, and a placeholder stays visible until content
 * replaces it. When the server's answer lands (`ready`), the article is
 * placed again at the server's progress, in place and without hiding, unless
 * the user has scrolled, clicked, or used the keyboard since opening. After
 * that the content may still change, but the scroll stays put.
 */
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
  const hasUserInteractedRef = useRef(false);
  // Which content the article was last placed for, and whether that placement
  // already used the server's progress.
  const placementRef = useRef<{ contentId: string; ready: boolean } | null>(
    null,
  );

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
    if (!articleElement) return;
    const placement =
      placementRef.current?.contentId === contentId
        ? placementRef.current
        : null;
    // The server's answer is the only reason to place a second time. Once it
    // has been used, or the user has taken over, the scroll is theirs.
    const settled = placement !== null && (placement.ready || !ready);
    if (settled || hasUserInteractedRef.current || progress === undefined) {
      setArticleRestorationVisibility(articleElement, true);
      return;
    }

    const contentElement = articleElement;
    const savedProgress = progress;
    // A first placement hides the article until it lands so the top of the
    // content never flashes; a second placement moves the visible article.
    const hideWhilePlacing = placement === null;
    let firstFrame = 0;
    let secondFrame = 0;
    const observer = new MutationObserver(() => scheduleRestore());

    function revealContent() {
      setArticleRestorationVisibility(contentElement, true);
    }

    function completeRestoration(element?: HTMLElement) {
      placementRef.current = { contentId, ready };
      observer.disconnect();
      if (element) scrollArticleBlockToTarget(element, "instant");
      else getScrollContainer().scrollTo({ top: 0, behavior: "instant" });
      revealContent();
    }

    function scheduleRestore() {
      if (firstFrame || hasUserInteractedRef.current) return;
      if (hasPendingContent(contentElement)) {
        revealContent();
        return;
      }
      const elements = getElements(contentElement);
      if (elements.length === 0 || savedProgress <= 0) {
        completeRestoration();
        return;
      }

      if (hideWhilePlacing)
        setArticleRestorationVisibility(contentElement, false);
      firstFrame = requestAnimationFrame(() => {
        firstFrame = 0;
        secondFrame = requestAnimationFrame(() => {
          secondFrame = 0;
          if (hasUserInteractedRef.current) return;
          if (hasPendingContent(contentElement)) {
            revealContent();
            return;
          }
          const renderedElements = getElements(contentElement);
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

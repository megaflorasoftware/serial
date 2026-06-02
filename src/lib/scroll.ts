import { useEffect, useLayoutEffect, useRef } from "react";

const DEFAULT_HOME_SCROLL_POSITION = 0;
let savedHomeScrollPosition: number | null = null;

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Returns the primary scroll container — the SidebarInset `<main>` element.
 * Falls back to `document.documentElement` when the sidebar layout isn't
 * mounted (e.g. auth pages).
 */
export function getScrollContainer(): HTMLElement {
  return (
    document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]') ??
    document.documentElement
  );
}

export function saveHomeScrollPosition() {
  savedHomeScrollPosition = getScrollContainer().scrollTop;
}

function restoreHomeScrollPosition() {
  const scrollTop = savedHomeScrollPosition ?? DEFAULT_HOME_SCROLL_POSITION;
  getScrollContainer().scrollTo({ top: scrollTop, behavior: "instant" });
}

export function useHomeScrollRestoration() {
  const canSaveScrollRef = useRef(false);

  useIsomorphicLayoutEffect(() => {
    canSaveScrollRef.current = false;
    restoreHomeScrollPosition();

    const restoreAnimationFrame = requestAnimationFrame(() => {
      restoreHomeScrollPosition();
      canSaveScrollRef.current = true;
      saveHomeScrollPosition();
    });

    return () => {
      cancelAnimationFrame(restoreAnimationFrame);
      canSaveScrollRef.current = false;
    };
  }, []);

  useEffect(() => {
    const container = getScrollContainer();

    const handleScroll = () => {
      if (!canSaveScrollRef.current) return;

      saveHomeScrollPosition();
    };

    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, []);
}

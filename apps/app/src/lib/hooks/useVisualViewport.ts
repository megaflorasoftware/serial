import { useCallback } from "react";

/** Size a mounted surface from the visible viewport, including the keyboard. */
export function useVisualViewport(enabled = true) {
  return useCallback(
    (element: HTMLElement | null) => {
      if (!enabled || !element) return;
      const viewport = window.visualViewport;
      let frame = 0;
      let height = -1;
      let top = -1;
      const measure = () => {
        const nextHeight = viewport?.height ?? window.innerHeight;
        const nextTop = viewport?.offsetTop ?? 0;
        if (height !== nextHeight) {
          height = nextHeight;
          element.style.setProperty("--visual-viewport-height", `${height}px`);
        }
        if (top !== nextTop) {
          top = nextTop;
          element.style.setProperty("--visual-viewport-top", `${top}px`);
        }
      };
      const schedule = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(measure);
      };
      measure();
      viewport?.addEventListener("resize", schedule);
      viewport?.addEventListener("scroll", schedule);
      window.addEventListener("resize", schedule);
      return () => {
        cancelAnimationFrame(frame);
        viewport?.removeEventListener("resize", schedule);
        viewport?.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", schedule);
        element.style.removeProperty("--visual-viewport-height");
        element.style.removeProperty("--visual-viewport-top");
      };
    },
    [enabled],
  );
}

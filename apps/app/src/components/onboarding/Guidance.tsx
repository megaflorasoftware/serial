import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { GuidanceLayer } from "./GuidanceLayer";
import type { GuidancePosition } from "./GuidanceLayer";

const POPUP_SELECTOR =
  '[data-guidance-popup], [data-slot="popover-content"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
function visible(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.getBoundingClientRect().width > 0 &&
    element.getBoundingClientRect().height > 0
  );
}
function openDialogs() {
  return Array.from(
    document.querySelectorAll('[role="dialog"][data-state="open"]'),
  ).filter(
    (element): element is HTMLElement =>
      visible(element) && !element.matches(POPUP_SELECTOR),
  );
}

function guidanceTarget(selector: string) {
  const candidates = Array.from(document.querySelectorAll(selector)).filter(
    visible,
  );
  const modal = openDialogs().at(-1);
  return (
    candidates.find((element) => modal?.contains(element)) ??
    candidates[0] ??
    null
  );
}

function boundsOf(elements: Array<HTMLElement | null>) {
  const rects = elements
    .filter((node): node is HTMLElement => !!node)
    .map((node) => node.getBoundingClientRect());
  return rects.length
    ? {
        x: Math.min(...rects.map((r) => r.x)),
        y: Math.min(...rects.map((r) => r.y)),
        width:
          Math.max(...rects.map((r) => r.right)) -
          Math.min(...rects.map((r) => r.x)),
        height:
          Math.max(...rects.map((r) => r.bottom)) -
          Math.min(...rects.map((r) => r.y)),
      }
    : null;
}

function naturalHelperHeight(element: HTMLDivElement) {
  const content = element.querySelector<HTMLElement>("[data-guidance-content]");
  return (
    element.offsetHeight +
    (content ? content.scrollHeight - content.clientHeight : 0)
  );
}

const EMPTY: GuidancePosition = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  highlightX: 0,
  highlightY: 0,
  highlightWidth: 0,
  highlightHeight: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  viewportTop: 0,
  layoutWidth: 0,
  layoutHeight: 0,
  bodyHost: false,
  bottomDrawerOpen: false,
  helperHidden: false,
};

function useGuidanceTarget(
  selector: string | undefined,
  instructionKey: string,
  anchorSelector: string | undefined,
  hideWhenSelector: string | undefined,
  highlightDialog: boolean,
  confirming: boolean,
  helper: RefObject<HTMLDivElement | null>,
  layer: RefObject<HTMLDivElement | null>,
) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState(EMPTY);
  const [helperHeight, setHelperHeight] = useState(150);
  const targetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    let focused: HTMLElement | null = null;
    const measure = () => {
      if (helper.current) setHelperHeight(naturalHelperHeight(helper.current));
      const dialogs = openDialogs();
      const activeHost = dialogs.at(-1) ?? document.body;
      setHost((old) => (old === activeHost ? old : activeHost));
      const target = selector ? guidanceTarget(selector) : null;
      targetRef.current = target;
      const popups = Array.from(
        document.querySelectorAll(POPUP_SELECTOR),
      ).filter(visible);
      const anchors = anchorSelector
        ? Array.from(document.querySelectorAll(anchorSelector)).filter(visible)
        : [];
      const activePopup = popups.at(-1);
      const rect = boundsOf(
        activePopup ? [activePopup] : anchors.length ? anchors : [target],
      );
      const highlightedDialog = highlightDialog
        ? target?.closest<HTMLElement>('[role="dialog"][data-state="open"]')
        : null;
      const highlight = highlightedDialog
        ? boundsOf([highlightedDialog, ...popups])
        : boundsOf([target, ...popups]);
      const viewport = window.visualViewport;
      const focusedInput = target?.matches("input, textarea") ? target : null;
      if (
        focusedInput &&
        rect &&
        (rect.y < (viewport?.offsetTop ?? 0) ||
          rect.y + rect.height >
            (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 64)
      ) {
        focusedInput.scrollIntoView({ block: "center", behavior: "instant" });
      }
      const updated: GuidancePosition = {
        helperHidden:
          !!hideWhenSelector && !!document.querySelector(hideWhenSelector),
        x: Math.max(0, (rect?.x ?? 0) - 5),
        y: Math.max(0, (rect?.y ?? 0) - 5),
        width: rect ? rect.width + 10 : 0,
        height: rect ? rect.height + 10 : 0,
        highlightX: Math.max(0, (highlight?.x ?? 0) - 5),
        highlightY: Math.max(0, (highlight?.y ?? 0) - 5),
        highlightWidth: highlight ? highlight.width + 10 : 0,
        highlightHeight: highlight ? highlight.height + 10 : 0,
        viewportWidth: viewport?.width ?? innerWidth,
        viewportHeight: viewport?.height ?? innerHeight,
        viewportTop: viewport?.offsetTop ?? 0,
        layoutWidth: innerWidth,
        layoutHeight: innerHeight,
        bodyHost: activeHost === document.body,
        bottomDrawerOpen: dialogs.some((dialog) =>
          dialog.matches('[data-vaul-drawer-direction="bottom"]'),
        ),
      };
      setPosition((old) =>
        Object.keys(updated).every(
          (key) =>
            old[key as keyof GuidancePosition] ===
            updated[key as keyof GuidancePosition],
        )
          ? old
          : updated,
      );
      if (target && target !== focused && !confirming) {
        focused = target;
        const control = target.matches(FOCUSABLE)
          ? target
          : target.querySelector<HTMLElement>(FOCUSABLE);
        control?.focus({ preventScroll: true });
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !layer.current?.contains(record.target)))
        schedule();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state", "style", "aria-expanded"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("animationend", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    // Recheck after dialog/sidebar entry transitions settle, without a perpetual animation loop.
    const timeout = setTimeout(schedule, 250);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [
    selector,
    instructionKey,
    anchorSelector,
    hideWhenSelector,
    highlightDialog,
    confirming,
    helper,
    layer,
  ]);
  return { host, position, helperHeight, setHelperHeight, targetRef };
}

function useGuidanceInteractions({
  selector,
  host,
  confirming,
  targetRef,
  layer,
  interactiveDialog,
  onSkip,
  onCancelSkip,
}: {
  selector?: string;
  host: HTMLElement | null;
  confirming: boolean;
  targetRef: RefObject<HTMLElement | null>;
  layer: RefObject<HTMLDivElement | null>;
  interactiveDialog: boolean;
  onSkip: () => void;
  onCancelSkip: () => void;
}) {
  const callbacks = useRef({ onSkip, onCancelSkip });
  useLayoutEffect(() => {
    callbacks.current = { onSkip, onCancelSkip };
  });
  useLayoutEffect(() => {
    const interactiveRoot = () =>
      interactiveDialog
        ? targetRef.current?.closest<HTMLElement>(
            '[role="dialog"][data-state="open"]',
          )
        : targetRef.current;
    const allowed = (node: Node) =>
      layer.current?.contains(node) ||
      (!confirming &&
        (interactiveRoot()?.contains(node) ||
          (node instanceof Element && !!node.closest(POPUP_SELECTOR))));
    const blockOutside = (event: Event) => {
      if (!(event.target instanceof Node) || allowed(event.target)) return;
      if (!selector && !confirming) return;
      event.preventDefault();
      // Let Vaul track a drag from the current drawer's handle or background,
      // but defer blur until a click so a dismiss swipe preserves the draft.
      if (
        event.type === "pointerdown" &&
        !confirming &&
        event.target instanceof Element &&
        event.target.closest("[data-vaul-drawer]") === host &&
        !event.target.closest(FOCUSABLE)
      )
        return;
      event.stopImmediatePropagation();
      if (
        event.target instanceof Element &&
        event.target
          .closest('button[aria-label="Close"], button:has(.sr-only)')
          ?.textContent?.trim() === "Close"
      )
        callbacks.current.onSkip();
      else if (
        event.type === "click" &&
        !confirming &&
        document.activeElement instanceof HTMLElement
      )
        document.activeElement.blur();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirming) {
          event.preventDefault();
          event.stopImmediatePropagation();
          callbacks.current.onCancelSkip();
          return;
        }
        if (
          document.querySelector(
            `${POPUP_SELECTOR}, [role="combobox"][aria-expanded="true"], [data-escape-dismisses="true"]`,
          )
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        callbacks.current.onSkip();
        return;
      }
      if (event.key !== "Tab") return;
      const roots = confirming
        ? [layer.current]
        : [
            interactiveRoot(),
            ...document.querySelectorAll<HTMLElement>(POPUP_SELECTOR),
            layer.current,
          ];
      if (!selector && !confirming) roots.push(host);
      const elements = [
        ...new Set(
          roots.flatMap((root) =>
            root
              ? [
                  ...(root.matches(FOCUSABLE) ? [root] : []),
                  ...root.querySelectorAll<HTMLElement>(FOCUSABLE),
                ]
              : [],
          ),
        ),
      ]
        .filter(visible)
        .filter((element) => element.tabIndex >= 0);
      if (!elements.length) return;
      const index = elements.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      event.stopImmediatePropagation();
      elements[
        (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length
      ]?.focus();
    };
    document.addEventListener("pointerdown", blockOutside, true);
    document.addEventListener("click", blockOutside, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", blockOutside, true);
      document.removeEventListener("click", blockOutside, true);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [selector, host, confirming, targetRef, layer, interactiveDialog]);
}

/** Presentation only. The caller owns instructions, advancement, and persistence. */
export function Guidance({
  instructionKey,
  selector,
  anchorSelector,
  hideWhenSelector,
  highlightDialog = false,
  interactiveDialog = false,
  dimmed = true,
  children,
  next,
  explanation = false,
  onNext,
  onSkip,
  confirming,
  onCancelSkip,
  onConfirmSkip,
}: {
  instructionKey: string;
  selector?: string;
  anchorSelector?: string;
  hideWhenSelector?: string;
  highlightDialog?: boolean;
  interactiveDialog?: boolean;
  dimmed?: boolean;
  children?: ReactNode;
  next?: boolean;
  explanation?: boolean;
  onNext?: () => void;
  onSkip: () => void;
  confirming: boolean;
  onCancelSkip: () => void;
  onConfirmSkip: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const helper = useRef<HTMLDivElement>(null);
  const { host, position, helperHeight, setHelperHeight, targetRef } =
    useGuidanceTarget(
      selector,
      instructionKey,
      anchorSelector,
      hideWhenSelector,
      highlightDialog,
      confirming,
      helper,
      layer,
    );
  useLayoutEffect(() => {
    const node = layer.current;
    if (!node?.isConnected) return;
    node.showPopover();
    if (helper.current) {
      setHelperHeight(naturalHelperHeight(helper.current));
    }
    if (confirming || (next && explanation))
      helper.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (node.isConnected) node.hidePopover();
    };
  }, [host, confirming, next, explanation, instructionKey, setHelperHeight]);
  useGuidanceInteractions({
    selector,
    host,
    confirming,
    targetRef,
    layer,
    interactiveDialog,
    onSkip,
    onCancelSkip,
  });

  if (!host) return null;
  return (
    <GuidanceLayer
      host={host}
      layer={layer}
      helper={helper}
      position={position}
      helperHeight={helperHeight}
      selector={selector}
      dimmed={dimmed}
      confirming={confirming}
      next={!!next}
      onNext={onNext}
      onSkip={onSkip}
      onCancelSkip={onCancelSkip}
      onConfirmSkip={onConfirmSkip}
    >
      {children}
    </GuidanceLayer>
  );
}

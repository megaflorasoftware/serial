import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";
import { Button } from "~/components/ui/button";

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

type Position = {
  x: number;
  y: number;
  width: number;
  height: number;
  highlightX: number;
  highlightY: number;
  highlightWidth: number;
  highlightHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportTop: number;
  bottomDrawerOpen: boolean;
};
const EMPTY: Position = {
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
  bottomDrawerOpen: false,
};

function useGuidanceTarget(
  selector: string | undefined,
  instructionKey: string,
  anchorSelector: string | undefined,
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
      if (helper.current) setHelperHeight(helper.current.offsetHeight);
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
      const updated: Position = {
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
        bottomDrawerOpen: dialogs.some((dialog) =>
          dialog.matches('[data-vaul-drawer-direction="bottom"]'),
        ),
      };
      setPosition((old) =>
        Object.keys(updated).every(
          (key) =>
            old[key as keyof Position] === updated[key as keyof Position],
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
    highlightDialog,
    confirming,
    helper,
    layer,
  ]);
  return { host, position, helperHeight, setHelperHeight, targetRef };
}

/** Presentation only. The caller owns instructions, advancement, and persistence. */
export function Guidance({
  instructionKey,
  selector,
  anchorSelector,
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
      highlightDialog,
      confirming,
      helper,
      layer,
    );
  const callbacks = useRef({ onSkip, onCancelSkip });
  useLayoutEffect(() => {
    callbacks.current = { onSkip, onCancelSkip };
  });

  useLayoutEffect(() => {
    const node = layer.current;
    if (!node?.isConnected) return;
    node.showPopover();
    if (helper.current) {
      setHelperHeight(helper.current.offsetHeight);
    }
    if (confirming || (next && explanation))
      helper.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (node.isConnected) node.hidePopover();
    };
  }, [host, confirming, next, explanation, instructionKey, setHelperHeight]);

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
        // An expanded selector owns the first Escape. Its enclosing dialog also guards that event.
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
  }, [selector, host, confirming, targetRef, interactiveDialog]);

  if (!host) return null;
  const { x, y, width, height, viewportWidth, viewportHeight, viewportTop } =
    position;
  const helperWidth = Math.min(300, viewportWidth - 32);
  const { highlightX, highlightY, highlightWidth, highlightHeight } = position;
  const radius = Math.min(6, highlightWidth / 2, highlightHeight / 2);

  const bottom = viewportTop + viewportHeight;
  const minTop = viewportTop + (position.bottomDrawerOpen ? 64 : 12);
  const maxBottom = bottom - (position.bottomDrawerOpen ? 12 : 64);
  const clampLeft = (value: number) =>
    Math.max(16, Math.min(value, viewportWidth - helperWidth - 16));
  const clampTop = (value: number) =>
    Math.max(minTop, Math.min(value, maxBottom - helperHeight));
  const candidates = [
    { side: "right", left: x + width + 12, top: clampTop(y) },
    { side: "left", left: x - helperWidth - 12, top: clampTop(y) },
    { side: "top", left: clampLeft(x), top: y - helperHeight - 12 },
    { side: "bottom", left: clampLeft(x), top: y + height + 12 },
  ];
  const { side, left, top } = candidates.find(
    (candidate) =>
      candidate.left >= 16 &&
      candidate.left + helperWidth <= viewportWidth - 16 &&
      candidate.top >= minTop &&
      candidate.top + helperHeight <= maxBottom,
  ) ?? { side: "bottom", left: clampLeft(x), top: clampTop(y + height + 12) };
  const arrowX =
    Math.max(16, Math.min(x + width / 2 - left, helperWidth - 16)) - 5;
  const arrowY =
    Math.max(16, Math.min(y + height / 2 - top, helperHeight - 16)) - 5;
  return createPortal(
    <div
      ref={layer}
      popover="manual"
      data-guidance-layer
      data-vaul-no-drag
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-none fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-visible border-0 bg-transparent p-0 text-inherit"
    >
      {selector && dimmed && (
        <svg
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 h-full w-full"
        >
          <path
            className="fill-black/35 dark:fill-black/65"
            fillRule="evenodd"
            d={[
              `M0 0H${innerWidth}V${innerHeight}H0Z`,
              `M${highlightX + radius} ${highlightY}`,
              `H${highlightX + highlightWidth - radius}Q${highlightX + highlightWidth} ${highlightY} ${highlightX + highlightWidth} ${highlightY + radius}`,
              `V${highlightY + highlightHeight - radius}Q${highlightX + highlightWidth} ${highlightY + highlightHeight} ${highlightX + highlightWidth - radius} ${highlightY + highlightHeight}`,
              `H${highlightX + radius}Q${highlightX} ${highlightY + highlightHeight} ${highlightX} ${highlightY + highlightHeight - radius}`,
              `V${highlightY + radius}Q${highlightX} ${highlightY} ${highlightX + radius} ${highlightY}Z`,
            ].join(" ")}
          />
        </svg>
      )}
      {confirming ? (
        <div
          className={`pointer-events-auto fixed inset-0 flex items-center justify-center p-4 ${dimmed ? "bg-black/60" : ""}`}
        >
          <div
            ref={helper}
            // Guidance traps Tab and Escape inside this existing Radix modal.
            // A second native modal would make its highlighted controls inert.
            // react-doctor-disable-next-line react-doctor/prefer-html-dialog
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="skip-onboarding-title"
            aria-describedby="skip-onboarding-description"
            className="bg-background grid w-full max-w-sm gap-4 rounded-lg border p-6 shadow-lg"
          >
            <h2 id="skip-onboarding-title" className="text-lg font-semibold">
              Skip onboarding?
            </h2>
            <p
              id="skip-onboarding-description"
              className="text-muted-foreground text-sm"
            >
              Your saved feeds, views, and settings will stay as they are.
            </p>
            <Button variant="outline" onClick={onCancelSkip}>
              Keep going
            </Button>
            <Button onClick={onConfirmSkip}>Skip onboarding</Button>
          </div>
        </div>
      ) : (
        <>
          {children && (
            <div
              ref={helper}
              role="region"
              aria-label="Onboarding guidance"
              className="bg-popover text-popover-foreground pointer-events-auto fixed grid gap-3 rounded-lg border p-4 text-sm shadow-lg"
              style={{ left, top, width: helperWidth }}
            >
              {selector && width > 0 && (
                <span
                  aria-hidden="true"
                  data-guidance-caret
                  data-side={side}
                  className="bg-popover pointer-events-none absolute size-2.5 rotate-45 data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=left]:border-t data-[side=left]:border-r data-[side=right]:border-b data-[side=right]:border-l data-[side=top]:border-r data-[side=top]:border-b"
                  style={{
                    left:
                      side === "right"
                        ? -6
                        : side === "left"
                          ? undefined
                          : arrowX,
                    right: side === "left" ? -6 : undefined,
                    top:
                      side === "bottom"
                        ? -6
                        : side === "top"
                          ? undefined
                          : arrowY,
                    bottom: side === "top" ? -6 : undefined,
                  }}
                />
              )}
              {children}
              {next && (
                <Button size="sm" onClick={onNext}>
                  Next
                </Button>
              )}
            </div>
          )}
          <Button
            variant="secondary"
            className="pointer-events-auto fixed left-1/2 -translate-x-1/2 shadow-sm"
            style={{
              top: position.bottomDrawerOpen
                ? `calc(${viewportTop + 16}px + env(safe-area-inset-top, 0px))`
                : bottom - 52,
            }}
            onPointerDown={onSkip}
            onClick={onSkip}
          >
            Skip Onboarding
          </Button>
        </>
      )}
    </div>,
    host,
  );
}

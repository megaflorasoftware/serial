import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";
import { Button } from "~/components/ui/button";

const POPUP_SELECTOR =
  '[data-guidance-popup], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';
const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';
function visible(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.getBoundingClientRect().width > 0 &&
    element.getBoundingClientRect().height > 0
  );
}
function guidanceTarget(selector: string) {
  const candidates = Array.from(document.querySelectorAll(selector)).filter(
    visible,
  );
  const modal = Array.from(
    document.querySelectorAll('[role="dialog"][data-state="open"]'),
  )
    .filter(visible)
    .at(-1);
  return (
    candidates.find((element) => modal?.contains(element)) ??
    candidates[0] ??
    null
  );
}

type Position = {
  x: number;
  y: number;
  width: number;
  height: number;
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
  viewportWidth: 0,
  viewportHeight: 0,
  viewportTop: 0,
  bottomDrawerOpen: false,
};

function useGuidanceTarget(
  selector: string | undefined,
  instructionKey: string,
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
      const dialogs = Array.from(
        document.querySelectorAll('[role="dialog"][data-state="open"]'),
      ).filter(visible);
      const activeHost = dialogs.at(-1) ?? document.body;
      setHost((old) => (old === activeHost ? old : activeHost));
      const target = selector ? guidanceTarget(selector) : null;
      targetRef.current = target;
      const popup = guidanceTarget(POPUP_SELECTOR);
      const rects = [target, popup]
        .filter((node): node is HTMLElement => !!node)
        .map((node) => node.getBoundingClientRect());
      const rect = rects.length
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
  }, [selector, instructionKey, confirming, helper, layer]);
  return { host, position, helperHeight, setHelperHeight, targetRef };
}

/** Presentation only. The caller owns instructions, advancement, and persistence. */
export function Guidance({
  instructionKey,
  selector,
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
  children?: ReactNode;
  next?: boolean;
  explanation?: boolean;
  onNext?: () => void;
  onSkip: () => void;
  confirming: boolean;
  onCancelSkip: () => void;
  onConfirmSkip: () => void;
}) {
  useLayoutEffect(() => {
    document.body.dataset.guidanceActive = "true";
    return () => {
      delete document.body.dataset.guidanceActive;
    };
  }, []);
  const layer = useRef<HTMLDivElement>(null);
  const helper = useRef<HTMLDivElement>(null);
  const { host, position, helperHeight, setHelperHeight, targetRef } =
    useGuidanceTarget(selector, instructionKey, confirming, helper, layer);
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
    const allowed = (node: Node) =>
      layer.current?.contains(node) ||
      (!confirming &&
        (targetRef.current?.contains(node) ||
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
            targetRef.current,
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
  }, [selector, host, confirming, targetRef]);

  if (!host) return null;
  const { x, y, width, height, viewportWidth, viewportHeight, viewportTop } =
    position;
  const helperWidth = Math.min(300, viewportWidth - 32);
  const radius = Math.min(6, width / 2, height / 2);

  const bottom = viewportTop + viewportHeight;
  const beside = x + width + helperWidth + 24 < viewportWidth;
  const above = y - helperHeight - 16 >= viewportTop + 12;
  const left = beside
    ? x + width + 12
    : Math.max(16, Math.min(x, viewportWidth - helperWidth - 16));
  const top = beside
    ? Math.max(viewportTop + 12, Math.min(y, bottom - helperHeight - 64))
    : above
      ? y - helperHeight - 12
      : Math.max(viewportTop + 12, bottom - helperHeight - 64);
  return createPortal(
    <div
      ref={layer}
      popover="manual"
      data-guidance-layer
      data-vaul-no-drag
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-none fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-visible border-0 bg-transparent p-0 text-inherit"
    >
      {selector && (
        <svg
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 h-full w-full"
        >
          <path
            fill="rgb(0 0 0 / 0.35)"
            fillRule="evenodd"
            d={[
              `M0 0H${innerWidth}V${innerHeight}H0Z`,
              `M${x + radius} ${y}`,
              `H${x + width - radius}Q${x + width} ${y} ${x + width} ${y + radius}`,
              `V${y + height - radius}Q${x + width} ${y + height} ${x + width - radius} ${y + height}`,
              `H${x + radius}Q${x} ${y + height} ${x} ${y + height - radius}`,
              `V${y + radius}Q${x} ${y} ${x + radius} ${y}Z`,
            ].join(" ")}
          />
        </svg>
      )}
      {confirming ? (
        <div className="pointer-events-auto fixed inset-0 flex items-center justify-center bg-black/60 p-4">
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
              Your saved Feeds, Views, and settings will stay as they are.
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

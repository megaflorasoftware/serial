import { createPortal } from "react-dom";
import type { ReactNode, RefObject } from "react";
import { Button } from "~/components/ui/button";

export type GuidancePosition = {
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
  layoutWidth: number;
  layoutHeight: number;
  bodyHost: boolean;
  bottomDrawerOpen: boolean;
  helperHidden: boolean;
};

type Placement = {
  side: string;
  left: number;
  top: number;
  width: number;
  maxHeight?: number;
  arrowX: number;
  arrowY: number;
};

function placementFor(position: GuidancePosition, helperHeight: number) {
  const { x, y, width, height, viewportWidth, viewportHeight, viewportTop } =
    position;
  const helperWidth = Math.min(300, viewportWidth - 32);
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
  const fullPlacement = candidates.find(
    (candidate) =>
      candidate.left >= 16 &&
      candidate.left + helperWidth <= viewportWidth - 16 &&
      candidate.top >= minTop &&
      candidate.top + helperHeight <= maxBottom,
  );
  const belowTop = Math.max(minTop, y + height + 12);
  const aboveBottom = Math.min(maxBottom, y - 12);
  const belowSpace = maxBottom - belowTop;
  const aboveSpace = aboveBottom - minTop;
  // Keep short keyboard viewports clear of the control. Scroll the instructions
  // when neither side can accommodate their natural height.
  const compactPlacement =
    belowSpace >= aboveSpace && belowSpace > 48
      ? {
          side: "bottom",
          left: clampLeft(x),
          top: belowTop,
          maxHeight: belowSpace,
        }
      : aboveSpace > 48
        ? {
            side: "top",
            left: clampLeft(x),
            top: minTop,
            maxHeight: aboveSpace,
          }
        : {
            side: "bottom",
            left: clampLeft(x),
            top: clampTop(y + height + 12),
            maxHeight: Math.max(48, maxBottom - minTop),
          };
  const selected = fullPlacement ?? compactPlacement;
  return {
    ...selected,
    width: helperWidth,
    maxHeight: fullPlacement ? undefined : compactPlacement.maxHeight,
    arrowX:
      Math.max(16, Math.min(x + width / 2 - selected.left, helperWidth - 16)) -
      5,
    arrowY:
      Math.max(16, Math.min(y + height / 2 - selected.top, helperHeight - 16)) -
      5,
  } satisfies Placement;
}

function GuidanceDimmer({ position }: { position: GuidancePosition }) {
  const { highlightX, highlightY, highlightWidth, highlightHeight } = position;
  const radius = Math.min(6, highlightWidth / 2, highlightHeight / 2);
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 h-full w-full"
    >
      <path
        className="fill-black/10"
        fillRule="evenodd"
        d={[
          `M0 0H${position.layoutWidth}V${position.layoutHeight}H0Z`,
          `M${highlightX + radius} ${highlightY}`,
          `H${highlightX + highlightWidth - radius}Q${highlightX + highlightWidth} ${highlightY} ${highlightX + highlightWidth} ${highlightY + radius}`,
          `V${highlightY + highlightHeight - radius}Q${highlightX + highlightWidth} ${highlightY + highlightHeight} ${highlightX + highlightWidth - radius} ${highlightY + highlightHeight}`,
          `H${highlightX + radius}Q${highlightX} ${highlightY + highlightHeight} ${highlightX} ${highlightY + highlightHeight - radius}`,
          `V${highlightY + radius}Q${highlightX} ${highlightY} ${highlightX + radius} ${highlightY}Z`,
        ].join(" ")}
      />
    </svg>
  );
}

function SkipConfirmation({
  helper,
  onCancel,
  onConfirm,
}: {
  helper: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
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
          Skip Tutorial?
        </h2>
        <p
          id="skip-onboarding-description"
          className="text-muted-foreground text-sm"
        >
          Your saved feeds, views, and settings will stay as they are.
        </p>
        <Button variant="outline" onClick={onCancel}>
          Keep going
        </Button>
        <Button onClick={onConfirm}>Skip Tutorial</Button>
      </div>
    </div>
  );
}

function GuidanceCaret({ placement }: { placement: Placement }) {
  const { side, arrowX, arrowY } = placement;
  return (
    <span
      aria-hidden="true"
      data-guidance-caret
      data-side={side}
      className="bg-popover pointer-events-none absolute size-2.5 rotate-45 data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=left]:border-t data-[side=left]:border-r data-[side=right]:border-b data-[side=right]:border-l data-[side=top]:border-r data-[side=top]:border-b"
      style={{
        left: side === "right" ? -6 : side === "left" ? undefined : arrowX,
        right: side === "left" ? -6 : undefined,
        top: side === "bottom" ? -6 : side === "top" ? undefined : arrowY,
        bottom: side === "top" ? -6 : undefined,
      }}
    />
  );
}

function GuidanceHelper({
  helper,
  placement,
  showCaret,
  children,
  next,
  onNext,
}: {
  helper: RefObject<HTMLDivElement | null>;
  placement: Placement;
  showCaret: boolean;
  children: ReactNode;
  next: boolean;
  onNext?: () => void;
}) {
  return (
    <div
      ref={helper}
      role="region"
      aria-label="Onboarding guidance"
      className="bg-popover text-popover-foreground pointer-events-auto fixed grid rounded-lg border p-4 text-sm shadow-lg"
      style={{
        left: placement.left,
        top: placement.top,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
    >
      {showCaret && <GuidanceCaret placement={placement} />}
      <div
        data-guidance-content
        className="grid min-h-0 gap-3 overflow-y-auto overscroll-contain"
      >
        {children}
        {next && (
          <Button size="sm" onClick={onNext}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}

function SkipButton({
  position,
  onSkip,
}: {
  position: GuidancePosition;
  onSkip: () => void;
}) {
  const bottom = position.viewportTop + position.viewportHeight;
  return (
    <Button
      variant="secondary"
      className="pointer-events-auto fixed left-1/2 -translate-x-1/2 shadow-sm"
      style={{
        top: position.bottomDrawerOpen
          ? `calc(${position.viewportTop + 16}px + env(safe-area-inset-top, 0px))`
          : bottom - 52,
      }}
      onPointerDown={onSkip}
      onClick={onSkip}
    >
      Skip Tutorial
    </Button>
  );
}

export function GuidanceLayer({
  host,
  layer,
  helper,
  position,
  helperHeight,
  selector,
  dimmed,
  confirming,
  children,
  next,
  onNext,
  onSkip,
  onCancelSkip,
  onConfirmSkip,
}: {
  host: HTMLElement;
  layer: RefObject<HTMLDivElement | null>;
  helper: RefObject<HTMLDivElement | null>;
  position: GuidancePosition;
  helperHeight: number;
  selector?: string;
  dimmed: boolean;
  confirming: boolean;
  children?: ReactNode;
  next: boolean;
  onNext?: () => void;
  onSkip: () => void;
  onCancelSkip: () => void;
  onConfirmSkip: () => void;
}) {
  const placement = placementFor(position, helperHeight);
  const showDimmer =
    !!selector &&
    dimmed &&
    position.bodyHost &&
    !confirming &&
    position.highlightWidth > 0;
  return createPortal(
    <div
      ref={layer}
      popover="manual"
      data-guidance-layer
      data-vaul-no-drag
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-none fixed inset-0 m-0 h-full max-h-none w-full max-w-none overflow-visible border-0 bg-transparent p-0 text-inherit"
    >
      {showDimmer && <GuidanceDimmer position={position} />}
      {confirming ? (
        <SkipConfirmation
          helper={helper}
          onCancel={onCancelSkip}
          onConfirm={onConfirmSkip}
        />
      ) : (
        <>
          {children && !position.helperHidden && (
            <GuidanceHelper
              helper={helper}
              placement={placement}
              showCaret={!!selector && position.width > 0}
              next={next}
              onNext={onNext}
            >
              {children}
            </GuidanceHelper>
          )}
          <SkipButton position={position} onSkip={onSkip} />
        </>
      )}
    </div>,
    host,
  );
}

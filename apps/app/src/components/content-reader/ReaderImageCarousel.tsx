"use client";

import { useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";

/**
 * A scroll-snapped strip showing one image per viewport. Native swipes and
 * the edge buttons share one source of truth: the strip's scroll position.
 */
export function ReaderImageCarousel({
  count,
  renderSlide,
}: {
  count: number;
  renderSlide: (index: number) => ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);

  const onScroll = () => {
    const strip = stripRef.current;
    if (!strip || strip.clientWidth === 0) return;
    const index = Math.round(strip.scrollLeft / strip.clientWidth);
    setCurrent(Math.max(0, Math.min(count - 1, index)));
  };

  const scrollTo = (index: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.scrollTo({ left: index * strip.clientWidth, behavior: "smooth" });
    // Scroll events do not fire in every environment; keep the controls honest.
    setCurrent(index);
  };

  return (
    <div data-reader-carousel>
      <div data-reader-carousel-viewport>
        <div ref={stripRef} data-reader-carousel-strip onScroll={onScroll}>
          {Array.from({ length: count }, (_, index) => (
            <div key={index} data-reader-carousel-slide>
              {renderSlide(index)}
            </div>
          ))}
        </div>
        {current > 0 && (
          <CarouselArrow
            direction="previous"
            onClick={() => scrollTo(current - 1)}
          />
        )}
        {current < count - 1 && (
          <CarouselArrow
            direction="next"
            onClick={() => scrollTo(current + 1)}
          />
        )}
      </div>
      <p data-reader-carousel-counter>
        {current + 1} / {count}
      </p>
    </div>
  );
}

function CarouselArrow({
  direction,
  onClick,
}: {
  direction: "previous" | "next";
  onClick: () => void;
}) {
  const Icon = direction === "previous" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-reader-carousel-arrow={direction}
      aria-label={direction === "previous" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white ${direction === "previous" ? "left-2" : "right-2"}`}
      onClick={onClick}
    >
      <Icon className="size-5" />
    </Button>
  );
}

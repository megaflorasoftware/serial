"use client";

import { createContext, useContext, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal } from "~/components/ui/dialog";

export type LightboxImage = { src: string; alt?: string };

type LightboxGroup = {
  images: LightboxImage[];
  open: (index: number) => void;
};

const LightboxGroupContext = createContext<LightboxGroup | null>(null);

/**
 * One preview dialog for a set of images. Every trigger inside opens it on
 * its own image; the dialog pages with the edge buttons and the arrow keys.
 */
export function ArticleImageLightboxGroup({
  images,
  children,
}: {
  images: LightboxImage[];
  children: ReactNode;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const current = index === null ? null : images[index];
  const count = images.length;
  const previous = index !== null && index > 0 ? index - 1 : null;
  const next = index !== null && index < count - 1 ? index + 1 : null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" && previous !== null) {
      event.preventDefault();
      setIndex(previous);
    } else if (event.key === "ArrowRight" && next !== null) {
      event.preventDefault();
      setIndex(next);
    }
  };

  return (
    <LightboxGroupContext.Provider value={{ images, open: setIndex }}>
      {children}
      <Dialog
        open={current !== null}
        onOpenChange={(open) => {
          if (!open) setIndex(null);
        }}
      >
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            className="fixed inset-4 z-50 flex flex-col items-center justify-center gap-2 focus:outline-none"
            onClick={() => setIndex(null)}
            onKeyDown={onKeyDown}
          >
            <DialogPrimitive.Title className="sr-only">
              Image preview
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Full-size image preview
            </DialogPrimitive.Description>
            {current && (
              <img
                src={current.src}
                alt={current.alt}
                decoding="async"
                referrerPolicy="no-referrer"
                className="min-h-0 rounded object-contain"
                style={{ maxWidth: "100%", maxHeight: "100%" }}
              />
            )}
            {count > 1 && index !== null && (
              <p
                data-lightbox-counter
                className="text-muted-foreground shrink-0 text-sm"
              >
                {index + 1} / {count}
              </p>
            )}
            {previous !== null && (
              <LightboxArrow
                direction="previous"
                onClick={() => setIndex(previous)}
              />
            )}
            {next !== null && (
              <LightboxArrow direction="next" onClick={() => setIndex(next)} />
            )}
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </LightboxGroupContext.Provider>
  );
}

function LightboxArrow({
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
      data-lightbox-arrow={direction}
      aria-label={direction === "previous" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 text-white hover:bg-black/60 hover:text-white ${direction === "previous" ? "left-2" : "right-2"}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon className="size-5" />
    </Button>
  );
}

/** The image in the flow; clicking it opens the group's dialog on this image. */
export function ArticleImageLightboxTrigger({
  index,
  className,
  style,
}: {
  index: number;
  className?: string;
  /** Layout hints from the Reader document: aspect ratio and capped width. */
  style?: CSSProperties;
}) {
  const group = useContext(LightboxGroupContext);
  const [failedSrc, setFailedSrc] = useState<string>();
  const image = group?.images[index];
  if (!group || !image) return null;
  const { src, alt } = image;
  const failed = failedSrc === src;

  return (
    <div data-lightbox style={{ position: "relative" }}>
      <button
        data-lightbox-trigger
        type="button"
        aria-label={alt ? `Open image preview: ${alt}` : "Open image preview"}
        aria-disabled={failed}
        style={{
          display: "block",
          cursor: failed ? "default" : "zoom-in",
        }}
        onClick={() => {
          if (!failed) group.open(index);
        }}
      >
        {failed ? (
          <span
            data-image-fallback
            role="img"
            aria-label={alt}
            className="bg-muted block aspect-square size-48 max-w-full rounded"
          />
        ) : (
          <img
            src={src}
            alt={alt}
            className={className}
            style={style}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(src)}
          />
        )}
      </button>
    </div>
  );
}

interface ArticleImageLightboxProps {
  src: string;
  alt?: string;
  className?: string;
  /** Layout hints from the Reader document: aspect ratio and capped width. */
  style?: CSSProperties;
}

/** A single image with its own preview dialog: a group of one. */
export function ArticleImageLightbox({
  src,
  alt,
  className,
  style,
}: ArticleImageLightboxProps) {
  return (
    <ArticleImageLightboxGroup images={[{ src, alt }]}>
      <ArticleImageLightboxTrigger
        index={0}
        className={className}
        style={style}
      />
    </ArticleImageLightboxGroup>
  );
}

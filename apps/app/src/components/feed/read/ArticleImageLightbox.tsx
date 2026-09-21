"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { CSSProperties } from "react";
import { Dialog, DialogOverlay, DialogPortal } from "~/components/ui/dialog";

interface ArticleImageLightboxProps {
  src: string;
  alt?: string;
  className?: string;
  /** Layout hints from the Reader document: aspect ratio and capped width. */
  style?: CSSProperties;
}

export function ArticleImageLightbox({
  src,
  alt,
  className,
  style,
}: ArticleImageLightboxProps) {
  const [open, setOpen] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string>();
  const failed = failedSrc === src;

  const toggle = () => {
    if (!failed) setOpen((prev) => !prev);
  };

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
        onClick={toggle}
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
            onError={() => {
              setFailedSrc(src);
              setOpen(false);
            }}
          />
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            className="fixed inset-4 z-50 flex items-center justify-center focus:outline-none"
            onClick={() => setOpen(false)}
          >
            <DialogPrimitive.Title className="sr-only">
              Image preview
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Full-size image preview
            </DialogPrimitive.Description>
            <img
              src={src}
              alt={alt}
              decoding="async"
              referrerPolicy="no-referrer"
              className="rounded object-contain"
              style={{ maxWidth: "100%", maxHeight: "100%" }}
            />
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </div>
  );
}

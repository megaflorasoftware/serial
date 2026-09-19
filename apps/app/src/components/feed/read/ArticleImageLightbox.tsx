"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Dialog, DialogOverlay, DialogPortal } from "~/components/ui/dialog";

interface ArticleImageLightboxProps {
  src: string;
  alt?: string;
  className?: string;
}

export function ArticleImageLightbox({
  src,
  alt,
  className,
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
          width: failed ? "100%" : undefined,
          maxWidth: failed ? "100%" : undefined,
          cursor: failed ? "default" : "zoom-in",
        }}
        onClick={toggle}
      >
        {failed ? (
          <span
            data-image-fallback
            role="img"
            aria-label={alt}
            className="bg-muted relative block aspect-video w-full overflow-hidden rounded"
          >
            {alt && (
              <span className="text-muted-foreground absolute inset-0 flex items-center justify-center px-8 py-4 text-center text-sm leading-relaxed sm:px-16">
                <span className="line-clamp-4 min-w-0 wrap-anywhere">
                  {alt}
                </span>
              </span>
            )}
          </span>
        ) : (
          <img
            src={src}
            alt={alt}
            className={className}
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

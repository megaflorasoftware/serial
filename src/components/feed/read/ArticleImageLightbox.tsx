"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div
      data-lightbox
      role="button"
      tabIndex={0}
      style={{ position: "relative", cursor: "zoom-in" }}
      onClick={() => setOpen(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      <img src={src} alt={alt} className={className} />
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
            <img
              src={src}
              alt={alt}
              className="rounded object-contain"
              style={{ maxWidth: "100%", maxHeight: "100%" }}
            />
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </div>
  );
}

import * as React from "react";

import { ArrowLeftIcon, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import type {
  DropdownMenuContentProps,
  DropdownMenuItemProps,
} from "@radix-ui/react-dropdown-menu";
import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "~/components/ui/drawer";
import { useMediaQuery } from "~/lib/hooks/use-media-query";
import { useVisualViewport } from "~/lib/hooks/useVisualViewport";

export function ResponsiveDropdownMenuItem({
  children,
  ...rest
}: DropdownMenuItemProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return <DropdownMenuItem {...rest}>{children}</DropdownMenuItem>;
  }

  return children;
}

export function ResponsiveDropdownLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DropdownMenuLabel className={className}>{children}</DropdownMenuLabel>
    );
  }

  return <div className={className}>{children}</div>;
}

interface ResponsiveDropdownProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  description?: string;
  side?: DropdownMenuContentProps["side"];
}
export function ResponsiveDropdown({
  children,
  trigger,
  title,
  description,
  side,
}: ResponsiveDropdownProps) {
  const [open, setOpen] = React.useState(false);
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg p-4"
          align="end"
          sideOffset={4}
          side={side}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent>
        <DrawerHeader className="text-left">
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-4">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

interface ControlledResponsiveDialogProps {
  hideClose?: boolean;
  previewDrawer?: boolean;
  mobileSheet?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  title?: string;
  description?: React.ReactNode;
  className?: string;
  headerClassName?: string;
  titleClassName?: string;
  onBack?: () => void;
  headerRight?: React.ReactNode;
  footer?: React.ReactNode;
  footerBorder?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
}

type ResolvedControlledDialogProps = ControlledResponsiveDialogProps & {
  hideClose: boolean;
  previewDrawer: boolean;
  mobileSheet: boolean;
  footerBorder: boolean;
};

function ControlledDesktopDialog({
  hideClose,
  open,
  onOpenChange,
  children,
  title,
  description,
  onBack,
  headerRight,
  className,
  headerClassName,
  titleClassName,
  footer,
  footerBorder,
  onOpenAutoFocus,
}: ResolvedControlledDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className={cn(
          "flex max-h-[calc(100vh-6rem)] flex-col overflow-hidden",
          className,
        )}
        onOpenAutoFocus={onOpenAutoFocus}
        onEscapeKeyDown={(event) => {
          // A combobox popup (Base UI, e.g. the Atmosphere handle
          // typeahead) is its own layer above this dialog, but Radix only
          // tracks Radix layers: without this check the Escape that
          // dismisses the suggestions would tear down the dialog too.
          // `data-escape-dismisses` covers the popup-closed states the
          // field still wants first claim on (a search pending in the
          // debounce window, say) — aria-expanded alone can't see those.
          const target = event.target as HTMLElement | null;
          if (
            target?.closest(
              '[role="combobox"][aria-expanded="true"], [data-escape-dismisses="true"]',
            )
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className={cn("shrink-0", headerClassName)}>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground mb-4 flex w-fit items-center gap-1 text-sm transition-colors"
            >
              <ArrowLeftIcon size={16} />
              <span>Back</span>
            </button>
          )}
          <div className="relative flex items-center justify-between">
            <DialogTitle className={cn("flex-1", titleClassName)}>
              {title}
            </DialogTitle>
            <div className="absolute right-0 flex items-center gap-3">
              {headerRight}
              {!hideClose && (
                <DialogClose className="ring-offset-background focus:ring-ring rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden">
                  <XIcon className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogClose>
              )}
            </div>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 py-1">
          {children}
        </div>
        {footer && (
          <div className={cn("shrink-0 pt-4", footerBorder && "border-t")}>
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ControlledMobileDrawer({
  measureVisualViewport,
  previewDrawer,
  mobileSheet,
  open,
  onOpenChange,
  children,
  title,
  description,
  onBack,
  headerRight,
  headerClassName,
  titleClassName,
  footer,
  footerBorder,
  onOpenAutoFocus,
}: ResolvedControlledDialogProps & { measureVisualViewport: boolean }) {
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = useVisualViewport(open && measureVisualViewport);
  const setDrawerRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      drawerRef.current = element;
      return viewportRef(element);
    },
    [viewportRef],
  );

  return (
    <Drawer
      shouldScaleBackground={!previewDrawer}
      repositionInputs={!mobileSheet}
      open={open}
      onOpenChange={onOpenChange}
      onRelease={(_event, staysOpen) => {
        if (staysOpen) return;
        requestAnimationFrame(() => {
          const drawer = drawerRef.current;
          if (!drawer || drawer.dataset.state !== "open") return;
          // A controlled dismissal can be declined, for example while confirming
          // a skipped guide. Vaul leaves its drag styles behind in that case.
          drawer.style.removeProperty("transform");
          drawer.style.removeProperty("transition");
          const overlay = drawer.previousElementSibling;
          if (
            overlay instanceof HTMLElement &&
            overlay.hasAttribute("data-vaul-overlay")
          ) {
            overlay.style.removeProperty("opacity");
            overlay.style.removeProperty("transition");
          }
        });
      }}
    >
      <DrawerContent
        ref={setDrawerRef}
        overlayClassName={previewDrawer ? "bg-transparent" : undefined}
        className={cn(
          "max-h-[calc(100dvh-6rem)]",
          previewDrawer && "mx-auto w-full max-w-3xl",
          mobileSheet &&
            "top-[calc(var(--visual-viewport-top,0px)+6rem)] bottom-auto mt-0 h-[max(0px,calc(var(--visual-viewport-height,100dvh)-6rem))] max-h-none",
        )}
        onOpenAutoFocus={onOpenAutoFocus}
      >
        <DrawerHeader className={cn("shrink-0 text-left", headerClassName)}>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground mb-2 flex w-fit items-center gap-1 text-sm transition-colors"
            >
              <ArrowLeftIcon size={16} />
              <span>Back</span>
            </button>
          )}
          <div className="flex items-center justify-between">
            <DrawerTitle className={cn("flex-1", titleClassName)}>
              {title}
            </DrawerTitle>
            {headerRight}
          </div>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-1">
          {children}
        </div>
        {footer && (
          <div
            className={cn(
              "shrink-0 px-4 pt-4 pb-4",
              footerBorder && "border-t",
            )}
          >
            {footer}
          </div>
        )}
        {!footer && <div className="pb-4" />}
      </DrawerContent>
    </Drawer>
  );
}

export function ControlledResponsiveDialog({
  hideClose = false,
  previewDrawer = false,
  mobileSheet = false,
  open,
  onOpenChange,
  children,
  title,
  description,
  onBack,
  headerRight,
  className,
  headerClassName,
  titleClassName,
  footer,
  footerBorder = false,
  onOpenAutoFocus,
}: ControlledResponsiveDialogProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");
  const dialogProps: ResolvedControlledDialogProps = {
    hideClose,
    previewDrawer,
    mobileSheet,
    open,
    onOpenChange,
    children,
    title,
    description,
    onBack,
    headerRight,
    className,
    headerClassName,
    titleClassName,
    footer,
    footerBorder,
    onOpenAutoFocus,
  };

  if (isDesktop && !previewDrawer) {
    return <ControlledDesktopDialog {...dialogProps} />;
  }

  return (
    <ControlledMobileDrawer
      {...dialogProps}
      measureVisualViewport={!isDesktop && mobileSheet}
    />
  );
}

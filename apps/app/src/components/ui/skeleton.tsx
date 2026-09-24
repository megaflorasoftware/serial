import type React from "react";
import { cn } from "~/lib/utils";

function Skeleton({
  className,
  as: Component = "div",
  ...props
}: React.ComponentProps<"div"> & { as?: "div" | "span" }) {
  return (
    <Component
      data-slot="skeleton"
      className={cn("bg-accent animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };

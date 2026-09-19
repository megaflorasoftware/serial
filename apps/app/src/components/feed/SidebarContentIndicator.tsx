import { CircleSmall } from "lucide-react";

export const sidebarIndicatorClassName =
  "text-sidebar-accent group-hover/sidebar-row:text-sidebar-accent-foreground/50 shrink-0";

export function SidebarContentIndicator({
  hasContent,
}: {
  hasContent: boolean;
}) {
  return (
    <div
      className={`${sidebarIndicatorClassName} grid size-4 place-items-center`}
    >
      {hasContent ? (
        <div className="size-2.5 rounded-full bg-current" />
      ) : (
        <CircleSmall size={16} />
      )}
    </div>
  );
}

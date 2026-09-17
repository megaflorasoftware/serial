import { memo } from "react";
import { GridItemDisplay, ItemDisplay } from "./ItemDisplay";
import type { ItemSize } from "./ItemDisplay";

// Keep per-item callbacks inside the memo boundary. Reconciliation of another
// page and keyboard selection should not render every visible card again.
export const SelectableItemDisplay = memo(function SelectableItemDisplay({
  contentId,
  onSelectItem,
  grid = false,
  ...props
}: {
  contentId: string;
  onSelectItem?: (id: string) => void;
  grid?: boolean;
  size: ItemSize;
  isSelected: boolean;
  sectionItemType?: "feed" | "tag";
}) {
  const Display = grid ? GridItemDisplay : ItemDisplay;
  return (
    <Display
      {...props}
      contentId={contentId}
      onSelect={onSelectItem ? () => onSelectItem(contentId) : undefined}
    />
  );
});

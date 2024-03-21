"use client";

import { type VisibilityFilter, useFeed } from "~/lib/data/FeedProvider";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

export function ItemVisibilityChips() {
  const { visibilityFilter, setVisibilityFilter } = useFeed();

  return (
    <ToggleGroup
      type="single"
      value={visibilityFilter.toString()}
      onValueChange={(value) => {
        if (!value) return;
        setVisibilityFilter(value as VisibilityFilter);
      }}
      size="sm"
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="unread">Unread</ToggleGroupItem>
      <ToggleGroupItem value="later">Later</ToggleGroupItem>
    </ToggleGroup>
  );
}

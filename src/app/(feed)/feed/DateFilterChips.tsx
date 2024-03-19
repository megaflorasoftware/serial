"use client";

import { useFeed } from "~/components/FeedProvider";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

export function DateFilterChips() {
  const { dateFilter, setDateFilter } = useFeed();

  return (
    <ToggleGroup
      type="single"
      value={dateFilter}
      onValueChange={(value) => setDateFilter(value)}
      size="sm"
    >
      <ToggleGroupItem value="1">Today</ToggleGroupItem>
      <ToggleGroupItem value="7">This Week</ToggleGroupItem>
      <ToggleGroupItem value="30">This Month</ToggleGroupItem>
    </ToggleGroup>
  );
}

"use client";

import { useAtom, useAtomValue } from "jotai";
import { Loader2 } from "lucide-react";
import type { VisibilityFilter } from "~/lib/data/atoms";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { viewFilterAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useViewPaginationState } from "~/lib/data/store";

export function ItemVisibilityChips() {
  const [visibilityFilter, setVisibilityFilter] = useAtom(visibilityFilterAtom);
  const currentView = useAtomValue(viewFilterAtom);
  const viewPaginationState = useViewPaginationState();

  const viewId = currentView?.id;
  const paginationState = viewId
    ? viewPaginationState[viewId]?.[visibilityFilter]
    : undefined;
  const isLoading = paginationState?.isFetching ?? false;

  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        type="single"
        value={visibilityFilter.toString()}
        onValueChange={(value) => {
          if (!value) return;
          setVisibilityFilter(value as VisibilityFilter);
        }}
        size="sm"
      >
        <ToggleGroupItem value="unread">Unread</ToggleGroupItem>
        <ToggleGroupItem value="later">Later</ToggleGroupItem>
        <ToggleGroupItem value="read">Read</ToggleGroupItem>
      </ToggleGroup>
      {isLoading && (
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      )}
    </div>
  );
}

export function ItemVisibilitySelect() {
  const [visibilityFilter, setVisibilityFilter] = useAtom(visibilityFilterAtom);

  return (
    <Select
      value={visibilityFilter.toString()}
      onValueChange={(value) => {
        if (!value) return;
        setVisibilityFilter(value as VisibilityFilter);
      }}
    >
      <SelectTrigger>
        <SelectValue placeholder="Visibility" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="unread">Unread</SelectItem>
        <SelectItem value="later">Later</SelectItem>
        <SelectItem value="read">Read</SelectItem>
      </SelectContent>
    </Select>
  );
}

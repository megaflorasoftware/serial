"use client";

import { useAtom } from "jotai";
import type { VisibilityFilter } from "~/lib/data/atoms";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { visibilityFilterAtom } from "~/lib/data/atoms";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { KeyboardShortcutDisplay } from "~/components/ButtonWithShortcut";
import { VISIBILITY_SHORTCUTS } from "~/lib/constants/shortcuts";

export function ItemVisibilityChips() {
  const [visibilityFilter, setVisibilityFilter] = useAtom(visibilityFilterAtom);

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
      {(["unread", "read", "later"] as const).map((filter) => {
        const isActive = visibilityFilter === filter;
        return (
          <ToggleGroupItem key={filter} value={filter}>
            {filter.charAt(0).toUpperCase() + filter.slice(1)}
            <KeyboardShortcutDisplay
              shortcut={VISIBILITY_SHORTCUTS[filter]}
              position="right"
              isActive={isActive}
            />
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
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
        <SelectItem value="read">Read</SelectItem>
        <SelectItem value="later">Later</SelectItem>
      </SelectContent>
    </Select>
  );
}

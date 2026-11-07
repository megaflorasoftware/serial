"use client";

import { LaptopIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

export function ColorModeToggleGroup() {
  const { theme, setTheme } = useTheme();

  return (
    <ToggleGroup
      type="single"
      value={theme ?? "light"}
      onValueChange={setTheme}
    >
      <ToggleGroupItem
        className="w-full"
        value="light"
        aria-label="Toggle light mode"
      >
        <SunIcon className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem
        className="w-full"
        value="dark"
        aria-label="Toggle dark mode"
      >
        <MoonIcon className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem
        className="w-full"
        value="system"
        aria-label="Toggle system color theme"
      >
        <LaptopIcon className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

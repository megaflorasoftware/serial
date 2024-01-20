"use client";

import {
  MoonIcon,
  SunIcon,
  MagicWandIcon,
  LaptopIcon,
} from "@radix-ui/react-icons";
import { useTheme } from "next-themes";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export function ColorModeToggle() {
  const { theme, setTheme } = useTheme();
  const [isArcBrowser, setIsArcBrowser] = useState(false);

  function checkForArcBrowser() {
    const variable = getComputedStyle(document.body).getPropertyValue(
      "--arc-palette-background",
    );
    if (variable !== "") {
      setIsArcBrowser(true);
    }
  }

  return (
    <DropdownMenu onOpenChange={checkForArcBrowser}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon">
          {theme === "system" && (
            <LaptopIcon className="h-[1.2rem] w-[1.2rem]" />
          )}
          {theme === "light" && <SunIcon className="h-[1.2rem] w-[1.2rem]" />}
          {theme === "dark" && <MoonIcon className="h-[1.2rem] w-[1.2rem]" />}
          {theme === "arc" && (
            <MagicWandIcon className="h-[1.2rem] w-[1.2rem]" />
          )}
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          Dark
        </DropdownMenuItem>
        {isArcBrowser && (
          <DropdownMenuItem onClick={() => setTheme("arc")}>
            Arc
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => setTheme("system")}>
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { MoonIcon, SunIcon, LaptopIcon } from "@radix-ui/react-icons";
import clsx from "clsx";
import { WandIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

const iconClasses = (isSelected: boolean) =>
  clsx("h-[1.2rem] w-[1.2rem]", {
    block: isSelected,
    hidden: !isSelected,
  });

export function ColorModeToggle() {
  const { theme, setTheme } = useTheme();
  const [isArcBrowser, setIsArcBrowser] = useState(false);

  const [showIcons, setShowIcons] = useState(false);

  function checkForArcBrowser() {
    const variable = getComputedStyle(document.body).getPropertyValue(
      "--arc-palette-background",
    );
    if (variable !== "") {
      setIsArcBrowser(true);
    }
  }

  // dirty hack to avoid hydration errors I don't want to fix
  useEffect(() => {
    setShowIcons(true);
  }, []);

  return (
    <DropdownMenu onOpenChange={checkForArcBrowser}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon">
          {showIcons && (
            <>
              <LaptopIcon className={iconClasses(theme === "system")} />
              <SunIcon className={iconClasses(theme === "light")} />
              <MoonIcon className={iconClasses(theme === "dark")} />
              <WandIcon className={iconClasses(theme === "arc")} />
            </>
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

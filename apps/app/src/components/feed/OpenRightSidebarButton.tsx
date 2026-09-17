"use client";

import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useSidebar } from "~/components/ui/sidebar";

export function OpenRightSidebarButton() {
  const { toggleSidebar, openRightMobile } = useSidebar();

  return (
    <Button
      data-onboarding="open-feed-menu"
      aria-label="Open Feed menu"
      onClick={() => toggleSidebar("right")}
      size="icon"
      variant="outline"
    >
      {openRightMobile && <PanelRightCloseIcon size={16} />}
      {!openRightMobile && <PanelRightOpenIcon size={16} />}
    </Button>
  );
}

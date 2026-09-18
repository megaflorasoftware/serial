"use client";

import {
  LifeBuoyIcon,
  NotebookIcon,
  PaletteIcon,
  PlugIcon,
  ShieldIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { ColorThemeDropdownSidebar } from "./color-theme/ColorThemePopoverButton";
import { useDialogStore } from "~/components/feed/dialogStore";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { useSession } from "~/lib/auth-client";
import { getReleaseUrl } from "~/lib/constants";
import { useCanMutate } from "~/lib/data/offline-mutations";
import { IS_DEMO_INSTANCE } from "~/lib/demo";

export function LeftSidebarBottomNav() {
  const { data } = useSession();
  const isAdmin = data?.user.role === "admin";
  const launchDialog = useDialogStore((store) => store.launchDialog);
  const canMutate = useCanMutate();

  return (
    <SidebarGroup className="mt-auto">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <ColorThemeDropdownSidebar>
              <SidebarMenuButton>
                <PaletteIcon />
                <span>Appearance</span>
              </SidebarMenuButton>
            </ColorThemeDropdownSidebar>
          </SidebarMenuItem>
          {!IS_DEMO_INSTANCE && (
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled={!canMutate}
                onClick={() => launchDialog("connections")}
              >
                <PlugIcon />
                <span>Connections</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a
                href={getReleaseUrl()}
                target="_blank"
                rel="noopener noreferrer"
              >
                <NotebookIcon />
                <span>Release Log</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a
                target="_blank"
                rel="noopener noreferrer"
                href="https://github.com/megaflorasoftware/serial/issues/new?template=bug-report.md"
              >
                <LifeBuoyIcon />
                <span>Report Issue</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton asChild>
                <Link to="/admin/settings">
                  <ShieldIcon />
                  <span>Admin</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

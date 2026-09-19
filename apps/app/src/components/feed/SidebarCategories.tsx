"use client";

import { useState } from "react";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Edit2Icon, PlusIcon, SettingsIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useDialogStore } from "./dialogStore";
import { SidebarContentIndicator } from "./SidebarContentIndicator";
import { EditContentCategoryDialog } from "~/components/AddContentCategoryDialog";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import {
  categoryFilterAtom,
  contentStatusFilterAtom,
  dateFilterAtom,
  feedFilterAtom,
} from "~/lib/data/atoms";
import { useContentCategories } from "~/lib/data/content-categories";
import { useDeselectViewFilter } from "~/lib/data/views";
import {
  getNavigationAvailability,
  useNavigationSnapshot,
  useNavigationSnapshotStatus,
} from "~/lib/data/navigation/store";
import { isContentStatusAvailable } from "~/lib/content-status";
import { Skeleton } from "~/components/ui/skeleton";
import { useCanMutate } from "~/lib/data/offline-mutations";

export function SidebarCategories() {
  const canMutate = useCanMutate();
  const [
    selectedContentCategoryForEditing,
    setSelectedContentCategoryForEditing,
  ] = useState<null | number>(null);

  const setFeedFilter = useSetAtom(feedFilterAtom);
  const setDateFilter = useSetAtom(dateFilterAtom);
  const deselectViewFilter = useDeselectViewFilter();
  const [categoryFilter, setCategoryFilter] = useAtom(categoryFilterAtom);

  const launchDialog = useDialogStore((store) => store.launchDialog);

  const { contentCategories } = useContentCategories();
  const navigationSnapshot = useNavigationSnapshot();
  const navigationSnapshotStatus = useNavigationSnapshotStatus();
  const contentStatusFilter = useAtomValue(contentStatusFilterAtom);

  const categoryOptions = contentCategories.map((category) => ({
    ...category,
    hasEntries: isContentStatusAvailable(
      getNavigationAvailability(navigationSnapshot.tags, category.id),
      contentStatusFilter,
    ),
  }));

  const hasAnyItems = Object.values(navigationSnapshot.feeds).some(
    (availability) =>
      isContentStatusAvailable(availability, contentStatusFilter),
  );

  const updateCategoryFilter = (category: number) => {
    setFeedFilter(-1);
    setCategoryFilter(category);
    setDateFilter(30);
    deselectViewFilter();
  };

  return (
    <>
      <EditContentCategoryDialog
        selectedContentCategoryId={selectedContentCategoryForEditing}
        onClose={() => setSelectedContentCategoryForEditing(null)}
      />
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="pr-0 pb-2">
          <span className="inline-block flex-1">Tags</span>
          <div className="flex w-fit items-center justify-end">
            <SidebarMenuButton asChild>
              <Link to="/tags">
                <SettingsIcon size={16} />
              </Link>
            </SidebarMenuButton>
            <SidebarMenuButton
              disabled={!canMutate}
              onClick={() => launchDialog("add-content-category")}
            >
              <PlusIcon />
            </SidebarMenuButton>
          </div>
        </SidebarGroupLabel>
        <SidebarMenu>
          {navigationSnapshotStatus !== "success" ? (
            <div className="flex flex-col items-center gap-4 px-2 py-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton className="h-8 w-full" key={index} />
              ))}
            </div>
          ) : (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton
                  variant={categoryFilter === -1 ? "outline" : "default"}
                  className="group/sidebar-row"
                  onClick={() => {
                    updateCategoryFilter(-1);
                    setDateFilter(1);
                  }}
                >
                  <SidebarContentIndicator hasContent={hasAnyItems} />
                  All
                </SidebarMenuButton>
              </SidebarMenuItem>
              {categoryOptions.map((option) => {
                return (
                  <SidebarMenuItem key={option.id} className="group flex gap-1">
                    <SidebarMenuButton
                      variant={
                        option.id === categoryFilter ? "outline" : "default"
                      }
                      className="group/sidebar-row"
                      onClick={() => updateCategoryFilter(option.id)}
                    >
                      <SidebarContentIndicator hasContent={option.hasEntries} />
                      <span className="min-w-0 truncate">{option.name}</span>
                    </SidebarMenuButton>
                    <div className="group/button flex w-fit items-center justify-end">
                      <SidebarMenuButton
                        onClick={() =>
                          setSelectedContentCategoryForEditing(option.id)
                        }
                      >
                        <Edit2Icon className="opacity-30 transition-opacity group-hover/button:opacity-100" />
                      </SidebarMenuButton>
                    </div>
                  </SidebarMenuItem>
                );
              })}
            </>
          )}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

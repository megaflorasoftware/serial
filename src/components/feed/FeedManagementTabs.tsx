"use client";

import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { KeyboardShortcutDisplay } from "~/components/ButtonWithShortcut";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useShortcut } from "~/lib/hooks/useShortcut";

type FeedManagementTab = "feeds" | "views" | "tags";

const TAB_ROUTES: Record<FeedManagementTab, "/feeds" | "/views" | "/tags"> = {
  feeds: "/feeds",
  views: "/views",
  tags: "/tags",
};

export function FeedManagementTabs({ value }: { value: FeedManagementTab }) {
  const navigate = useNavigate();

  const goTo = useCallback(
    (tab: FeedManagementTab) => {
      void navigate({ to: TAB_ROUTES[tab] });
    },
    [navigate],
  );

  useShortcut("1", () => goTo("feeds"));
  useShortcut("2", () => goTo("views"));
  useShortcut("3", () => goTo("tags"));

  return (
    <Tabs value={value}>
      <TabsList variant="line">
        <TabsTrigger value="feeds" onClick={() => goTo("feeds")}>
          Feeds
          <KeyboardShortcutDisplay shortcut="1" position="right" />
        </TabsTrigger>
        <TabsTrigger value="views" onClick={() => goTo("views")}>
          Views
          <KeyboardShortcutDisplay shortcut="2" position="right" />
        </TabsTrigger>
        <TabsTrigger value="tags" onClick={() => goTo("tags")}>
          Tags
          <KeyboardShortcutDisplay shortcut="3" position="right" />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { viewsAtom, visibilityFilterAtom } from "~/lib/data/atoms";
import { ClientDatetime } from "~/components/feed/ClientDatetime";
import { ItemVisibilityChips } from "~/components/feed/ItemVisibilityChips";
import { MarkVisibleAsReadButton } from "~/components/feed/MarkVisibleAsReadButton";
import { RenderViewItems } from "~/components/feed/view-lists";
import { ViewFilterChips } from "~/components/feed/ViewFilterChips";
import { useUpdateViewFilter } from "~/lib/data/views";
import { useCanUseShortcuts } from "~/lib/hooks/useCanUseShortcuts";
import { MAX_VIEW_SHORTCUTS, SHORTCUT_KEYS } from "~/lib/constants/shortcuts";
import { getObjectEntries } from "~/lib/utils/getObjectEntries";

export const Route = createFileRoute("/_app/")({
  component: Home,
});

function useViewSelectionShortcuts() {
  const views = useAtomValue(viewsAtom);
  const updateViewFilter = useUpdateViewFilter();
  const { pathname } = useLocation();
  const { canUseShortcuts } = useCanUseShortcuts();

  useEffect(() => {
    if (pathname !== "/") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!canUseShortcuts) return;

      const num = parseInt(event.key, 10);
      if (num >= 1 && num <= MAX_VIEW_SHORTCUTS && num <= views.length) {
        const view = views[num - 1];
        if (view) {
          updateViewFilter(view.id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pathname, views, updateViewFilter, canUseShortcuts]);
}

function useVisibilityFilterShortcuts() {
  const { pathname } = useLocation();
  const { canUseShortcuts } = useCanUseShortcuts();
  const [, setVisibilityFilter] = useAtom(visibilityFilterAtom);

  useEffect(() => {
    if (pathname !== "/") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!canUseShortcuts) return;

      const key = event.key.toLowerCase();
      const filter = getObjectEntries(SHORTCUT_KEYS).find(
        ([, shortcut]) => shortcut === key,
      )?.[0];

      if (filter) {
        setVisibilityFilter(filter);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pathname, canUseShortcuts, setVisibilityFilter]);
}

function Home() {
  useViewSelectionShortcuts();
  useVisibilityFilterShortcuts();
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center lg:pb-18">
      <div className="flex w-full flex-col px-6 pb-6 md:items-center md:text-center">
        <h1 className="font-sans text-2xl font-bold">Serial</h1>
        <p className="pb-2 font-sans">
          <ClientDatetime />
        </p>
        <div className="flex w-max gap-1 pt-1">
          <ItemVisibilityChips />
        </div>
        <div className="w-max pt-3">
          <ViewFilterChips />
        </div>
      </div>
      <RenderViewItems />
      <MarkVisibleAsReadButton />
    </div>
  );
}

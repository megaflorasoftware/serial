"use client";

import { useLocation } from "@tanstack/react-router";
import clsx from "clsx";
import { RefreshCwIcon } from "lucide-react";
import { useCallback } from "react";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";
import { useLoadingMode } from "~/lib/data/loading-machine";
import { useFetchNewData } from "~/lib/data/store";
import { useShortcut } from "~/lib/hooks/useShortcut";

export function RefetchItemsButton() {
  const location = useLocation();
  const fetchNewData = useFetchNewData();
  const loading = useLoadingMode();

  const isRefreshing = loading.mode === "manualRefresh";
  const isDisabled =
    isRefreshing ||
    loading.mode === "initialLoad" ||
    loading.mode === "backgroundRefresh";

  const onClick = useCallback(async () => {
    if (isDisabled) return;
    await fetchNewData();
  }, [fetchNewData, isDisabled]);

  useShortcut("r", onClick);

  if (location.pathname !== "/") return null;

  return (
    <ButtonWithShortcut
      size="icon md:default"
      variant="outline"
      onClick={onClick}
      disabled={isDisabled}
      shortcut="r"
    >
      <RefreshCwIcon
        size={16}
        className={clsx({
          "animate-spin": isRefreshing,
        })}
      />
      <span className="hidden pl-1.5 md:block">Refresh</span>
    </ButtonWithShortcut>
  );
}

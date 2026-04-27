"use client";

import { useLocation } from "@tanstack/react-router";
import clsx from "clsx";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  useIsLoadingActive,
  useLoadingMode,
  useNextRefreshAt,
} from "~/lib/data/loading-machine";
import { useFetchNewData } from "~/lib/data/store";
import { useShortcut } from "~/lib/hooks/useShortcut";

function formatRelativeTime(targetMs: number, now: number): string {
  const diffMs = targetMs - now;
  if (diffMs <= 0) return "now";
  const diffSec = Math.ceil(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.ceil(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.ceil(diffMin / 60);
  return `${diffHr}h`;
}

export function RefetchItemsButton() {
  const location = useLocation();
  const fetchNewData = useFetchNewData();
  const loading = useLoadingMode();
  const nextRefreshAt = useNextRefreshAt();

  // Track current time in state so the cooldown check is pure during render.
  // Only updated via the timeout callback (async) to satisfy the lint rule.
  const [now, setNow] = useState(() => Date.now());

  const isRefreshing = useIsLoadingActive();
  const isRateLimited = nextRefreshAt !== null && nextRefreshAt > now;
  const isDisabled =
    isRefreshing ||
    isRateLimited ||
    loading.mode === "initialLoad" ||
    loading.mode === "backgroundRefresh";

  // When nextRefreshAt changes, schedule an update to `now` that will
  // re-enable the button once the cooldown expires. If already expired,
  // fires on next tick.
  useEffect(() => {
    if (nextRefreshAt === null) return;
    const remaining = nextRefreshAt - Date.now();
    const delay = remaining > 0 ? remaining + 100 : 0;
    const timeout = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timeout);
  }, [nextRefreshAt]);

  const onClick = useCallback(async () => {
    if (isDisabled) return;
    await fetchNewData();
  }, [fetchNewData, isDisabled]);

  useShortcut("r", onClick);

  if (location.pathname !== "/") return null;

  const button = (
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

  if (isRateLimited) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>
          Refresh available in {formatRelativeTime(nextRefreshAt, now)}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

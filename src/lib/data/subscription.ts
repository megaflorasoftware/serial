import { useQuery } from "@tanstack/react-query";
import { IS_MAIN_INSTANCE } from "~/lib/constants";
import { orpc } from "~/lib/orpc";

export function useSubscription() {
  const { data, isLoading } = useQuery({
    ...orpc.subscription.getStatus.queryOptions(),
    enabled: IS_MAIN_INSTANCE,
    staleTime: 60_000,
  });

  return {
    planId: data?.planId ?? "free",
    planName: data?.planName ?? "Free",
    maxActiveFeeds: data?.maxActiveFeeds ?? -1,
    activeFeeds: data?.activeFeeds ?? 0,
    backgroundRefreshIntervalMs: data?.backgroundRefreshIntervalMs ?? null,
    isLoading,
  };
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ConnectedAtmospherePane } from "~/components/connections/AtprotoConnection";
import { Button } from "~/components/ui/button";
import {
  advanceOnboarding,
  advanceSavedOnboardingStep,
} from "~/lib/onboarding/store";
import { orpc } from "~/lib/orpc";

export function OnboardingSyncSlide({
  run,
  userId,
}: {
  run: number;
  userId: string;
}) {
  const statusOptions = orpc.atproto.getConnectionStatus.queryOptions();
  const status = useQuery({
    ...statusOptions,
    queryKey: [...statusOptions.queryKey, userId],
    refetchOnMount: "always",
  });
  const [hasFreshStatus, setHasFreshStatus] = useState(false);
  const receivedFreshStatus =
    !!status.data &&
    status.isFetchedAfterMount &&
    !status.isFetching &&
    !status.isError;
  if (receivedFreshStatus && !hasFreshStatus) setHasFreshStatus(true);
  useEffect(() => {
    if (status.data && receivedFreshStatus) {
      if (!status.data.isConnected && !status.data.needsReconnect)
        advanceOnboarding("next-steps");
    }
  }, [receivedFreshStatus, status.data]);
  if (status.isError && !hasFreshStatus)
    return (
      <div className="grid gap-4">
        <p>Couldn&apos;t load your Atmosphere connection.</p>
        <Button onClick={() => void status.refetch()}>Retry</Button>
      </div>
    );
  if (!status.data || !hasFreshStatus) return <p>Loading your connection...</p>;
  return (
    <ConnectedAtmospherePane
      status={status.data}
      onboarding
      onSaved={() =>
        advanceSavedOnboardingStep(run, "atmosphere-sync-setup", "next-steps")
      }
    />
  );
}

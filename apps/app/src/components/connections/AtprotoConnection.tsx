import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AtprotoSyncSettingsForm } from "./AtprotoSyncSettingsForm";
import { ConnectedAccountRow } from "./ConnectedAccountRow";
import { ConnectionListRow } from "./ConnectionListRow";
import { AtprotoHandleField } from "~/components/auth/AtprotoHandleField";
import { orpc } from "~/lib/orpc";

function AtprotoConnectionForm() {
  const linkMutation = useMutation(
    orpc.atproto.linkAccount.mutationOptions({
      onSuccess: (data) => {
        // Hand the browser to the authorization server; the link callback
        // redirects back into the app with the result.
        window.location.assign(data.url);
      },
      onError: (error) => {
        toast.error(error.message || "Failed to connect Atmosphere account");
      },
    }),
  );

  return (
    <AtprotoHandleField
      id="atproto-handle"
      label="Connect with your Atmosphere handle"
      submitLabel="Connect"
      busy={linkMutation.isPending}
      focusOnMount
      onSubmit={(submission) => linkMutation.mutate(submission)}
    />
  );
}

function useAtprotoConnectionStatus() {
  return useQuery({
    ...orpc.atproto.getConnectionStatus.queryOptions(),
    // The link callback backfills the handle after redirecting, so a row
    // read right after linking can carry the raw DID. Poll while the
    // "handle" is still DID-shaped (real handles are domains); polling
    // stops when the row unmounts with the dialog.
    refetchInterval: (query) => {
      const data = query.state.data;
      const awaitingHandleBackfill =
        !!data?.isConnected && !!data.handle?.startsWith("did:");
      return awaitingHandleBackfill ? 3000 : false;
    },
  });
}

function useAtprotoUnlink() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.atproto.unlinkAccount.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.atproto.getConnectionStatus.queryKey(),
        });
        toast.success("Atmosphere account disconnected");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to disconnect Atmosphere");
      },
    }),
  );
}

export function AtprotoConnectionListItem({
  onSelect,
}: {
  onSelect: () => void;
}) {
  const { data: status, isLoading } = useAtprotoConnectionStatus();

  return (
    <ConnectionListRow
      name="Atmosphere"
      isLoading={isLoading}
      isConfigured={status?.isConfigured ?? false}
      statusText={
        // A connection that needs reconnecting still identifies itself by
        // its handle; the subpane's banner carries the expired state.
        (status?.isConnected || status?.needsReconnect) && status.handle
          ? status.handle
          : "Not connected"
      }
      onSelect={onSelect}
    />
  );
}

/**
 * The Atmosphere subpane: the handle field while nothing is attached (or
 * once Reconnect is pressed), otherwise the connected account with its
 * disconnect action and reconnect banner, and the subscription sync
 * settings beneath it. Settings are disabled behind the banner: reconnect
 * is the single call to action until the credentials are back.
 */
export function AtprotoConnectionPane() {
  const { data: status, isLoading } = useAtprotoConnectionStatus();
  const unlinkMutation = useAtprotoUnlink();
  const [reconnecting, setReconnecting] = useState(false);

  if (isLoading || !status) {
    return (
      <Loader2Icon className="text-muted-foreground animate-spin" size={20} />
    );
  }

  const attached = status.isConnected || status.needsReconnect;
  if (!attached || reconnecting) {
    return <AtprotoConnectionForm />;
  }

  return (
    <div className="grid gap-6">
      <ConnectedAccountRow
        label={status.handle ?? "Connected"}
        disconnecting={unlinkMutation.isPending}
        onDisconnect={() => unlinkMutation.mutate(undefined)}
        onReconnect={
          status.needsReconnect ? () => setReconnecting(true) : undefined
        }
      />
      <AtprotoSyncSettingsForm
        key={JSON.stringify(status.syncPreferences)}
        savedPreferences={status.syncPreferences}
        hasWriteScope={status.hasWriteScope}
        disabled={status.needsReconnect}
      />
    </div>
  );
}

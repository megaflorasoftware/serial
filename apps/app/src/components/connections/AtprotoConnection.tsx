import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import {
  AtprotoSyncSettingsForm,
  useAtprotoSyncSettingsSave,
} from "./AtprotoSyncSettingsForm";
import { ConnectedAccountRow } from "./ConnectedAccountRow";
import { ConnectionListRow } from "./ConnectionListRow";
import { AtprotoHandleField } from "~/components/auth/AtprotoHandleField";
import { Button } from "~/components/ui/button";
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
  const { data: status, isLoading, isError } = useAtprotoConnectionStatus();
  // Keep cached status after a failed poll, but let an initial failure
  // reach the pane's Retry action instead of treating it as unconfigured.
  const statusUnavailable = !status && isError;

  return (
    <ConnectionListRow
      name="Atmosphere"
      isLoading={isLoading}
      isConfigured={status?.isConfigured ?? statusUnavailable}
      statusText={
        statusUnavailable
          ? "Couldn't load connection"
          : (status?.isConnected || status?.needsReconnect) && status.handle
            ? status.handle
            : "Not connected"
      }
      onSelect={onSelect}
    />
  );
}

/**
 * A reconnect is a link of the DID the connection already holds, so it
 * starts the authorize round trip directly instead of asking for a handle
 * again; the link callback rebinds the same row.
 */
function useAtprotoReconnect() {
  return useMutation(
    orpc.atproto.reconnectAccount.mutationOptions({
      onSuccess: (data) => {
        window.location.assign(data.url);
      },
      onError: (error) => {
        toast.error(error.message || "Failed to reconnect Atmosphere account");
      },
    }),
  );
}

/**
 * The Atmosphere subpane: the handle field while nothing is attached,
 * otherwise the connected account with its disconnect action and reconnect
 * banner, and the subscription sync settings beneath it. Settings are
 * disabled behind the banner: reconnect is the single call to action until
 * the credentials are back.
 */
export function AtprotoConnectionPane() {
  const {
    data: status,
    isError,
    isFetching,
    refetch,
  } = useAtprotoConnectionStatus();
  const unlinkMutation = useAtprotoUnlink();
  const reconnectMutation = useAtprotoReconnect();
  const syncSettingsSave = useAtprotoSyncSettingsSave();
  // Either round trip leaves the page; neither action may start while the
  // other is under way.
  const accountBusy = unlinkMutation.isPending || reconnectMutation.isPending;

  // A later poll that fails keeps whatever status already rendered; only
  // a pane with nothing to show falls back to the retry card.
  if (!status) {
    return isError ? (
      <AtprotoStatusUnavailable
        retrying={isFetching}
        onRetry={() => void refetch()}
      />
    ) : (
      <Loader2Icon className="text-muted-foreground animate-spin" size={20} />
    );
  }

  const attached = status.isConnected || status.needsReconnect;
  if (!attached) {
    return <AtprotoConnectionForm />;
  }

  return (
    <div className="grid gap-6">
      <ConnectedAccountRow
        label={status.handle ?? "Connected"}
        disabled={accountBusy || syncSettingsSave.busy}
        disconnecting={unlinkMutation.isPending}
        onDisconnect={() => unlinkMutation.mutate(undefined)}
        onReconnect={
          status.needsReconnect
            ? () => reconnectMutation.mutate(undefined)
            : undefined
        }
        reconnecting={reconnectMutation.isPending}
      />
      <AtprotoSyncSettingsForm
        key={JSON.stringify(status.syncPreferences)}
        savedPreferences={status.syncPreferences}
        hasWriteScope={status.hasWriteScope}
        disabled={status.needsReconnect || accountBusy}
        saving={syncSettingsSave.busy}
        onSave={syncSettingsSave.save}
      />
    </div>
  );
}

/** The status request failed: say so and offer a retry, never a bare spinner. */
function AtprotoStatusUnavailable({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
      <span className="text-muted-foreground text-sm">
        Couldn&apos;t load your Atmosphere connection.
      </span>
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
        {retrying ? (
          <Loader2Icon className="animate-spin" size={16} />
        ) : (
          <RefreshCwIcon size={16} />
        )}
        <span className="ml-1.5">Retry</span>
      </Button>
    </div>
  );
}

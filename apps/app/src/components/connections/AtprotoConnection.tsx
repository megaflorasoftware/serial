import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AtprotoConnectionRow } from "./AtprotoConnectionRow";
import { AtprotoHandleField } from "~/components/auth/AtprotoHandleField";
import { orpc } from "~/lib/orpc";

export function AtprotoConnectionForm() {
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
      label="Handle"
      submitLabel="Connect"
      busy={linkMutation.isPending}
      focusOnMount
      onSubmit={(submission) => linkMutation.mutate(submission)}
    />
  );
}

export function AtprotoConnectionListItem({
  onSelect,
}: {
  onSelect: () => void;
}) {
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery({
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

  const computedStatus = status ?? {
    isConnected: false,
    needsReconnect: false,
    handle: null,
    isConfigured: false,
  };

  const unlinkMutation = useMutation(
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

  return (
    <AtprotoConnectionRow
      isLoading={isLoading}
      status={computedStatus}
      disconnecting={unlinkMutation.isPending}
      onSelect={onSelect}
      onDisconnect={() => unlinkMutation.mutate(undefined)}
    />
  );
}

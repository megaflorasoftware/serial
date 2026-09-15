import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConnectionListRow } from "./ConnectionListRow";
import { ConnectedAccountRow } from "./ConnectedAccountRow";
import { orpc } from "~/lib/orpc";

function InstapaperConnectionForm({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const queryClient = useQueryClient();

  const linkMutation = useMutation(
    orpc.instapaper.linkAccount.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.instapaper.getConnectionStatus.queryKey(),
        });
        toast.success("Instapaper account linked!");
        setUsername("");
        setPassword("");
        onSuccess();
      },
      onError: (error) => {
        toast.error(error.message || "Failed to link Instapaper account");
      },
    }),
  );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        linkMutation.mutate({ username, password });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="instapaper-username">Email or Username</Label>
        <Input
          id="instapaper-username"
          type="text"
          value={username}
          placeholder="email@example.com"
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="instapaper-password">Password</Label>
        <Input
          id="instapaper-password"
          type="password"
          value={password}
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <Button
        type="submit"
        disabled={linkMutation.isPending || !username || !password}
      >
        {linkMutation.isPending ? (
          <Loader2Icon className="animate-spin" size={16} />
        ) : (
          "Connect"
        )}
      </Button>
    </form>
  );
}

function useInstapaperConnectionStatus() {
  return useQuery(orpc.instapaper.getConnectionStatus.queryOptions());
}

function useInstapaperUnlink() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.instapaper.unlinkAccount.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.instapaper.getConnectionStatus.queryKey(),
        });
        toast.success("Instapaper account disconnected");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to disconnect Instapaper");
      },
    }),
  );
}

export function InstapaperConnectionListItem({
  onSelect,
}: {
  onSelect: () => void;
}) {
  const { data: status, isLoading } = useInstapaperConnectionStatus();

  return (
    <ConnectionListRow
      name="Instapaper"
      isLoading={isLoading}
      isConfigured={status?.isConfigured ?? false}
      statusText={
        status?.isConnected && status.username
          ? status.username
          : "Not connected"
      }
      onSelect={onSelect}
    />
  );
}

/**
 * The Instapaper subpane: the credentials form while not connected, the
 * connected username with its disconnect action once connected.
 */
export function InstapaperConnectionPane({
  onConnected,
}: {
  onConnected: () => void;
}) {
  const { data: status, isLoading } = useInstapaperConnectionStatus();
  const unlinkMutation = useInstapaperUnlink();

  if (isLoading) {
    return (
      <Loader2Icon className="text-muted-foreground animate-spin" size={20} />
    );
  }
  if (status?.isConnected) {
    return (
      <ConnectedAccountRow
        label={status.username ?? "Connected"}
        disconnecting={unlinkMutation.isPending}
        onDisconnect={() => unlinkMutation.mutate(undefined)}
      />
    );
  }
  return <InstapaperConnectionForm onSuccess={onConnected} />;
}

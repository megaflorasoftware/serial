import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useDialogStore } from "~/_todo/feed/dialogStore";
import { orpc } from "~/lib/orpc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ControlledResponsiveDialog } from "./ui/responsive-dropdown";

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

function InstapaperConnectedState({ username }: { username: string }) {
  const queryClient = useQueryClient();

  const unlinkMutation = useMutation(
    orpc.instapaper.unlinkAccount.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: orpc.instapaper.getConnectionStatus.queryKey(),
        });
        toast.success("Instapaper account unlinked");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to unlink Instapaper account");
      },
    }),
  );

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <div className="bg-primary/10 flex size-10 items-center justify-center rounded-full">
          <CheckIcon className="text-primary size-5" />
        </div>
        <div>
          <p className="font-medium">Connected</p>
          <p className="text-muted-foreground text-sm">{username}</p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => unlinkMutation.mutate()}
        disabled={unlinkMutation.isPending}
      >
        {unlinkMutation.isPending ? (
          <Loader2Icon className="animate-spin" size={16} />
        ) : (
          <>
            <UnplugIcon size={16} />
            <span className="ml-1.5">Disconnect</span>
          </>
        )}
      </Button>
    </div>
  );
}

export function ConnectionsDialog() {
  const dialog = useDialogStore((store) => store.dialog);
  const onDialogOpenChange = useDialogStore((store) => store.onOpenChange);

  const { data: connectionStatus, isLoading } = useQuery(
    orpc.instapaper.getConnectionStatus.queryOptions({
      enabled: dialog === "connections",
    }),
  );

  return (
    <ControlledResponsiveDialog
      open={dialog === "connections"}
      onOpenChange={onDialogOpenChange}
      title="Connections"
      description="Manage your connected services"
    >
      <div className="grid gap-6 pt-2">
        <div className="grid gap-3">
          <h3 className="font-semibold">Instapaper</h3>
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2Icon className="animate-spin" size={24} />
            </div>
          ) : !connectionStatus?.isConfigured ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
              Instapaper integration is not configured. Contact the admin to set
              up OAuth credentials.
            </div>
          ) : connectionStatus?.isConnected ? (
            <InstapaperConnectedState
              username={connectionStatus.username ?? ""}
            />
          ) : (
            <InstapaperConnectionForm onSuccess={() => {}} />
          )}
        </div>
      </div>
    </ControlledResponsiveDialog>
  );
}

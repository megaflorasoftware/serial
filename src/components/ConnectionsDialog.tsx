import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, Loader2Icon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useDialogStore } from "~/_todo/feed/dialogStore";
import { orpc } from "~/lib/orpc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ControlledResponsiveDialog } from "./ui/responsive-dropdown";

type ConnectionView = "list" | "instapaper";

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

function ConnectionsList({
  onSelectService,
}: {
  onSelectService: (service: ConnectionView) => void;
}) {
  const queryClient = useQueryClient();

  const { data: instapaperStatus, isLoading: isLoadingInstapaper } = useQuery(
    orpc.instapaper.getConnectionStatus.queryOptions(),
  );

  const unlinkMutation = useMutation(
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

  const isClickable =
    !isLoadingInstapaper &&
    !instapaperStatus?.isConnected &&
    instapaperStatus?.isConfigured;

  return (
    <div className="grid gap-2">
      <div
        role={isClickable ? "button" : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onClick={isClickable ? () => onSelectService("instapaper") : undefined}
        onKeyDown={
          isClickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectService("instapaper");
                }
              }
            : undefined
        }
        className={`flex items-center justify-between rounded-lg border p-4 ${
          isClickable ? "hover:bg-muted cursor-pointer transition-colors" : ""
        }`}
      >
        <div className="flex flex-col">
          <span className="font-medium">Instapaper</span>
          {isLoadingInstapaper ? (
            <span className="text-muted-foreground text-sm">Loading...</span>
          ) : instapaperStatus?.isConnected ? (
            <span className="text-muted-foreground text-sm">
              {instapaperStatus.username}
            </span>
          ) : !instapaperStatus?.isConfigured ? (
            <span className="text-muted-foreground text-sm">
              Not configured
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">Not connected</span>
          )}
        </div>
        {isLoadingInstapaper ? (
          <Loader2Icon
            className="text-muted-foreground animate-spin"
            size={20}
          />
        ) : instapaperStatus?.isConnected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              unlinkMutation.mutate();
            }}
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
        ) : instapaperStatus?.isConfigured ? (
          <ChevronRightIcon className="text-muted-foreground" size={20} />
        ) : null}
      </div>
    </div>
  );
}

export function ConnectionsDialog() {
  const [view, setView] = useState<ConnectionView>("list");

  const dialog = useDialogStore((store) => store.dialog);
  const onDialogOpenChange = useDialogStore((store) => store.onOpenChange);

  const handleOpenChange = (open: boolean) => {
    onDialogOpenChange(open);
    if (!open) {
      setView("list");
    }
  };

  const title = view === "list" ? "Connections" : "Instapaper";
  const description =
    view === "list"
      ? "Manage your connected services"
      : "Connect your Instapaper account";

  return (
    <ControlledResponsiveDialog
      open={dialog === "connections"}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      onBack={view !== "list" ? () => setView("list") : undefined}
    >
      {view === "list" ? (
        <ConnectionsList onSelectService={setView} />
      ) : view === "instapaper" ? (
        <InstapaperConnectionForm onSuccess={() => setView("list")} />
      ) : null}
    </ControlledResponsiveDialog>
  );
}

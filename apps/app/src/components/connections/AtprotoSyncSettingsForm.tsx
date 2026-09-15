import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type {
  AtprotoSyncMethod,
  AtprotoSyncPreferences,
} from "~/lib/auth/atproto-sync-settings";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
  ATPROTO_SYNC_METHOD_LABELS,
  ATPROTO_SYNC_METHODS,
  syncMethodNeedsWriteScope,
} from "~/lib/auth/atproto-sync-settings";
import { orpc } from "~/lib/orpc";

export const ATPROTO_PERMISSIONS_NOTICE =
  "In order to save Serial subscriptions to your PDS, we need additional permissions.";

/**
 * The Atmosphere subscription sync settings: the four-way method and the
 * inactive-import preference, saved together by one explicit Save so a
 * resync never follows an innocuous click. Local edits live only until
 * the pane unmounts; the caller remounts the form when the saved values
 * change.
 */
export function AtprotoSyncSettingsForm({
  savedPreferences,
  hasWriteScope,
  disabled,
}: {
  savedPreferences: AtprotoSyncPreferences;
  hasWriteScope: boolean;
  disabled: boolean;
}) {
  const [method, setMethod] = useState<AtprotoSyncMethod>(
    savedPreferences.method,
  );
  const [importAsInactive, setImportAsInactive] = useState(
    savedPreferences.importAsInactive,
  );
  // Stays busy through the navigation to the consent screen; a completed
  // save clears through the refetch and the caller's remount.
  const [redirecting, setRedirecting] = useState(false);
  const queryClient = useQueryClient();

  const saveMutation = useMutation(
    orpc.atproto.saveSyncSettings.mutationOptions({
      onSuccess: async (result) => {
        if (!result.saved) {
          // Nothing is saved yet: the authorization server's consent
          // screen is the confirmation, and the upgrade callback saves.
          setRedirecting(true);
          window.location.assign(result.consentUrl);
          return;
        }
        await queryClient.invalidateQueries({
          queryKey: orpc.atproto.getConnectionStatus.queryKey(),
        });
        toast.success("Settings saved");
      },
      onError: (error) => {
        toast.error(error.message || "Failed to save sync settings");
      },
    }),
  );

  const dirty =
    method !== savedPreferences.method ||
    importAsInactive !== savedPreferences.importAsInactive;
  const needsConsent = syncMethodNeedsWriteScope(method) && !hasWriteScope;
  const busy = saveMutation.isPending || redirecting;

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        saveMutation.mutate({ method, importAsInactive });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="atproto-sync-method">Sync subscriptions</Label>
        <ToggleGroup
          id="atproto-sync-method"
          type="single"
          value={method}
          disabled={disabled || busy}
          onValueChange={(value) => {
            if (!value) return;
            setMethod(value as AtprotoSyncMethod);
          }}
          className="flex w-fit flex-wrap justify-start gap-1"
        >
          {ATPROTO_SYNC_METHODS.map((option) => (
            <ToggleGroupItem
              key={option}
              size="sm"
              variant="outline"
              value={option}
            >
              {ATPROTO_SYNC_METHOD_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {needsConsent && (
          <p className="text-muted-foreground text-sm">
            {ATPROTO_PERMISSIONS_NOTICE}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-4">
        <Label
          htmlFor="atproto-import-as-inactive"
          className={disabled ? "text-muted-foreground" : ""}
        >
          Add imported subscriptions as inactive
        </Label>
        <Switch
          id="atproto-import-as-inactive"
          checked={importAsInactive}
          onCheckedChange={setImportAsInactive}
          disabled={disabled || busy}
        />
      </div>
      <Button type="submit" disabled={disabled || busy || !dirty}>
        {busy ? <Loader2Icon className="animate-spin" size={16} /> : "Save"}
      </Button>
    </form>
  );
}

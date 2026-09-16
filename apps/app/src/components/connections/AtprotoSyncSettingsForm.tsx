import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  AtprotoSyncMethod,
  AtprotoSyncPreferences,
} from "~/lib/auth/atproto-sync-settings";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
  ATPROTO_SYNC_METHOD_LABELS,
  ATPROTO_SYNC_METHODS,
  syncMethodNeedsWriteScope,
} from "~/lib/auth/atproto-sync-settings";
import { orpc } from "~/lib/orpc";

export const ATPROTO_PERMISSIONS_NOTICE =
  "In order to save Serial subscriptions to your PDS, we need additional permissions.";

/** The pane shares this operation state across Save and account actions. */
export function useAtprotoSyncSettingsSave() {
  // Keep controls locked until navigation, but let Back restore the form
  // if the user abandons consent and the browser retains this page.
  const [redirecting, setRedirecting] = useState(false);
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);
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
        void queryClient.invalidateQueries({
          queryKey: orpc.atproto.getSyncStatus.queryKey(),
        });
      },
      onError: (error) => {
        toast.error(error.message || "Failed to save sync settings");
      },
    }),
  );

  return {
    save: saveMutation.mutate,
    busy: saveMutation.isPending || redirecting,
  };
}

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
  saving,
  onSave,
}: {
  savedPreferences: AtprotoSyncPreferences;
  hasWriteScope: boolean;
  disabled: boolean;
  saving: boolean;
  onSave: (preferences: AtprotoSyncPreferences) => void;
}) {
  // Edits stay local until Save; the parent's key resets them after a saved change.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [method, setMethod] = useState<AtprotoSyncMethod>(
    savedPreferences.method,
  );
  // This is the other editable preference, reset by the same parent key.
  // react-doctor-disable-next-line react-doctor/no-derived-useState
  const [importAsInactive, setImportAsInactive] = useState(
    savedPreferences.importAsInactive,
  );

  const dirty =
    method !== savedPreferences.method ||
    importAsInactive !== savedPreferences.importAsInactive;
  const needsConsent = syncMethodNeedsWriteScope(method) && !hasWriteScope;

  return (
    // This client-only settings form submits through the shared oRPC mutation.
    // react-doctor-disable-next-line react-doctor/no-prevent-default
    <form
      className="grid gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ method, importAsInactive });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="atproto-sync-method">Subscription sync method</Label>
        <ToggleGroup
          id="atproto-sync-method"
          type="single"
          value={method}
          disabled={disabled || saving}
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
      <div className="grid gap-2">
        <Label htmlFor="atproto-import-state">
          Add imported Atmosphere feeds as
        </Label>
        <ToggleGroup
          id="atproto-import-state"
          type="single"
          value={importAsInactive ? "inactive" : "active"}
          disabled={disabled || saving}
          onValueChange={(value) => {
            if (!value) return;
            setImportAsInactive(value === "inactive");
          }}
          className="flex w-fit flex-wrap justify-start gap-1"
        >
          <ToggleGroupItem size="sm" variant="outline" value="active">
            Active
          </ToggleGroupItem>
          <ToggleGroupItem size="sm" variant="outline" value="inactive">
            Inactive
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <Button type="submit" disabled={disabled || saving || !dirty}>
        {saving ? <Loader2Icon className="animate-spin" size={16} /> : "Save"}
      </Button>
    </form>
  );
}

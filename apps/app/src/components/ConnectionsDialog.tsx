import {
  AtprotoConnectionListItem,
  AtprotoConnectionPane,
} from "./connections/AtprotoConnection";
import {
  InstapaperConnectionListItem,
  InstapaperConnectionPane,
} from "./connections/InstapaperConnection";
import { ControlledResponsiveDialog } from "./ui/responsive-dropdown";
import type { ConnectionsPane } from "~/components/feed/dialogStore";
import { useDialogStore } from "~/components/feed/dialogStore";

/**
 * Every connection is a status row in the list that navigates to its own
 * subpane; the subpane owns connecting, disconnecting, and any settings.
 * The active pane lives in the dialog store so a return from an OAuth
 * round trip can land directly on it.
 */
function ConnectionsList({
  onSelectService,
}: {
  onSelectService: (service: ConnectionsPane) => void;
}) {
  return (
    <div className="grid gap-2">
      <AtprotoConnectionListItem onSelect={() => onSelectService("atproto")} />
      <InstapaperConnectionListItem
        onSelect={() => onSelectService("instapaper")}
      />
    </div>
  );
}

const VIEW_TITLES: Record<ConnectionsPane, string> = {
  list: "Connections",
  instapaper: "Instapaper",
  atproto: "Atmosphere",
};

const VIEW_DESCRIPTIONS: Record<ConnectionsPane, string> = {
  list: "Manage your connected services",
  instapaper: "Connect your Instapaper account",
  atproto: "Connect your Atmosphere account",
};

export function ConnectionsDialog() {
  const dialog = useDialogStore((store) => store.dialog);
  const view = useDialogStore((store) => store.connectionsPane);
  const launchDialog = useDialogStore((store) => store.launchDialog);
  const onDialogOpenChange = useDialogStore((store) => store.onOpenChange);

  const setView = (pane: ConnectionsPane) => {
    launchDialog("connections", { connectionsPane: pane });
  };

  return (
    <ControlledResponsiveDialog
      open={dialog === "connections"}
      onOpenChange={onDialogOpenChange}
      title={VIEW_TITLES[view]}
      description={VIEW_DESCRIPTIONS[view]}
      onBack={view !== "list" ? () => setView("list") : undefined}
    >
      {view === "list" && <ConnectionsList onSelectService={setView} />}
      {view === "instapaper" && (
        <InstapaperConnectionPane onConnected={() => setView("list")} />
      )}
      {view === "atproto" && <AtprotoConnectionPane />}
    </ControlledResponsiveDialog>
  );
}

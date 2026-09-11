import {
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  UnplugIcon,
} from "lucide-react";
import { Button } from "../ui/button";

/**
 * Presentation for the connections-list row. A row is either clickable (to
 * start linking) or carries action buttons (including the reconnect banner
 * beneath it), never both — the Instapaper row's rule — so no button ever
 * nests inside the row's own button role.
 */
export function AtprotoConnectionRow({
  isLoading,
  status,
  disconnecting,
  onSelect,
  onDisconnect,
}: {
  isLoading: boolean;
  status: AtprotoConnectionStatus;
  disconnecting: boolean;
  onSelect: () => void;
  onDisconnect: () => void;
}) {
  const isClickable =
    !isLoading &&
    status.isConfigured &&
    !status.isConnected &&
    !status.needsReconnect;
  const showReconnectBanner = !isLoading && status.needsReconnect;

  return (
    <div
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={isClickable ? onSelect : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      className={`overflow-hidden rounded-lg border ${
        isClickable ? "hover:bg-muted cursor-pointer transition-colors" : ""
      }`}
    >
      <div className="flex items-center justify-between p-4">
        <div className="flex flex-col">
          <span className="font-medium">Atmosphere</span>
          <AtprotoConnectionStatusLine isLoading={isLoading} status={status} />
        </div>
        <AtprotoConnectionAction
          isLoading={isLoading}
          status={status}
          disconnecting={disconnecting}
          onDisconnect={onDisconnect}
        />
      </div>
      {showReconnectBanner && <AtprotoReconnectBanner onReconnect={onSelect} />}
    </div>
  );
}

export interface AtprotoConnectionStatus {
  isConnected: boolean;
  needsReconnect: boolean;
  handle: string | null;
  isConfigured: boolean;
}

function AtprotoConnectionStatusLine({
  isLoading,
  status,
}: {
  isLoading: boolean;
  status: AtprotoConnectionStatus;
}) {
  if (isLoading) {
    return <span className="text-muted-foreground text-sm">Loading...</span>;
  }
  if (!status.isConfigured) {
    return <span className="text-muted-foreground text-sm">Not available</span>;
  }
  if ((status.isConnected || status.needsReconnect) && status.handle) {
    // A connection that needs reconnecting still identifies itself by its
    // handle; the banner below the row carries the expired state.
    return (
      <span className="text-muted-foreground text-sm">{status.handle}</span>
    );
  }
  return <span className="text-muted-foreground text-sm">Not connected</span>;
}

function AtprotoConnectionAction({
  isLoading,
  status,
  disconnecting,
  onDisconnect,
}: {
  isLoading: boolean;
  status: AtprotoConnectionStatus;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  if (isLoading) {
    return (
      <Loader2Icon className="text-muted-foreground animate-spin" size={20} />
    );
  }
  if (!status.isConfigured) return null;
  if (status.isConnected || status.needsReconnect) {
    return (
      <DisconnectButton
        disconnecting={disconnecting}
        onDisconnect={onDisconnect}
      />
    );
  }
  return <ChevronRightIcon className="text-muted-foreground" size={20} />;
}

/**
 * Credentials were lost (revoked at the PDS, failed refresh) but the
 * sign-in method still exists. Same treatment as the demo banner: amber
 * strip, state on the left, the one action on the right.
 */
function AtprotoReconnectBanner({ onReconnect }: { onReconnect: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <span>Sign-in expired</span>
      <Button
        size="sm"
        className="flex items-center gap-1.5"
        onClick={onReconnect}
      >
        <RefreshCwIcon size={14} />
        Reconnect
      </Button>
    </div>
  );
}

function DisconnectButton({
  disconnecting,
  onDisconnect,
}: {
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onDisconnect}
      disabled={disconnecting}
    >
      {disconnecting ? (
        <Loader2Icon className="animate-spin" size={16} />
      ) : (
        <>
          <UnplugIcon size={16} />
          <span className="ml-1.5">Disconnect</span>
        </>
      )}
    </Button>
  );
}

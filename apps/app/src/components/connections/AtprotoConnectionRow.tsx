import {
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  UnplugIcon,
} from "lucide-react";
import { Button } from "../ui/button";

/**
 * Presentation for the connections-list row. A row is either clickable (to
 * start linking) or carries action buttons, never both — the Instapaper
 * row's rule — so no button ever nests inside the row's own button role.
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
      className={`flex items-center justify-between rounded-lg border p-4 ${
        isClickable ? "hover:bg-muted cursor-pointer transition-colors" : ""
      }`}
    >
      <div className="flex flex-col">
        <span className="font-medium">Atmosphere</span>
        <AtprotoConnectionStatusLine isLoading={isLoading} status={status} />
      </div>
      <AtprotoConnectionAction
        isLoading={isLoading}
        status={status}
        disconnecting={disconnecting}
        onReconnect={onSelect}
        onDisconnect={onDisconnect}
      />
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
  if (status.isConnected) {
    return (
      <span className="text-muted-foreground text-sm">{status.handle}</span>
    );
  }
  if (status.needsReconnect) {
    // Credentials were lost (revoked at the PDS, failed refresh) but
    // the sign-in method still exists: the line describes the state and
    // the Reconnect button beside it carries the verb.
    return (
      <span className="text-muted-foreground text-sm">
        {status.handle
          ? `Sign-in expired · ${status.handle}`
          : "Sign-in expired"}
      </span>
    );
  }
  return <span className="text-muted-foreground text-sm">Not connected</span>;
}

function AtprotoConnectionAction({
  isLoading,
  status,
  disconnecting,
  onReconnect,
  onDisconnect,
}: {
  isLoading: boolean;
  status: AtprotoConnectionStatus;
  disconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  if (isLoading) {
    return (
      <Loader2Icon className="text-muted-foreground animate-spin" size={20} />
    );
  }
  if (!status.isConfigured) return null;
  if (status.needsReconnect) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onReconnect}>
          <RefreshCwIcon size={16} />
          <span className="ml-1.5">Reconnect</span>
        </Button>
        <DisconnectButton
          disconnecting={disconnecting}
          onDisconnect={onDisconnect}
        />
      </div>
    );
  }
  if (status.isConnected) {
    return (
      <DisconnectButton
        disconnecting={disconnecting}
        onDisconnect={onDisconnect}
      />
    );
  }
  return <ChevronRightIcon className="text-muted-foreground" size={20} />;
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

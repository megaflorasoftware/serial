import { Loader2Icon, RefreshCwIcon, UnplugIcon } from "lucide-react";
import { Button } from "../ui/button";

/**
 * A subpane's connected-account block: the account identity on the left,
 * Disconnect on the right, and the reconnect banner beneath when the
 * credentials were lost but the account is still attached.
 */
export function ConnectedAccountRow({
  label,
  disabled = false,
  disconnecting = false,
  onDisconnect,
  onReconnect,
  reconnecting = false,
}: {
  label: string;
  /** Holds both actions, for instance while the other one is under way. */
  disabled?: boolean;
  /** The disconnect itself is in flight; shows on its own button only. */
  disconnecting?: boolean;
  onDisconnect?: () => void;
  /** Present only while the connection needs reconnecting. */
  onReconnect?: () => void;
  /** The reconnect itself is in flight; shows on its own button only. */
  reconnecting?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between p-4">
        <span className="font-medium">{label}</span>
        {onDisconnect && (
          <DisconnectButton
            disabled={disabled || disconnecting}
            disconnecting={disconnecting}
            onDisconnect={onDisconnect}
          />
        )}
      </div>
      {onReconnect && (
        <ReconnectBanner
          disabled={disabled || reconnecting}
          onReconnect={onReconnect}
          reconnecting={reconnecting}
        />
      )}
    </div>
  );
}

/**
 * Credentials were lost (revoked at the PDS, failed refresh) but the
 * sign-in method still exists. Same treatment as the demo banner: amber
 * strip, state on the left, the one action on the right.
 */
export function ReconnectBanner({
  disabled,
  onReconnect,
  reconnecting,
}: {
  disabled: boolean;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <span>Sign-in expired</span>
      <Button
        size="sm"
        className="flex items-center gap-1.5"
        onClick={onReconnect}
        disabled={disabled}
      >
        {reconnecting ? (
          <Loader2Icon className="animate-spin" size={14} />
        ) : (
          <RefreshCwIcon size={14} />
        )}
        Reconnect
      </Button>
    </div>
  );
}

function DisconnectButton({
  disabled,
  disconnecting,
  onDisconnect,
}: {
  disabled: boolean;
  disconnecting: boolean;
  onDisconnect: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onDisconnect}
      disabled={disabled}
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

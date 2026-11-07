import { ChevronRightIcon, Loader2Icon } from "lucide-react";

/**
 * The shared list row for a connection: a service name over a status line,
 * navigating to the service's subpane whenever the service is available.
 * The row never carries buttons; every action lives in the subpane.
 */
export function ConnectionListRow({
  name,
  isLoading,
  isConfigured,
  statusText,
  onSelect,
}: {
  name: string;
  isLoading: boolean;
  isConfigured: boolean;
  /** The status line once loaded: a handle, a username, or "Not connected". */
  statusText: string;
  onSelect: () => void;
}) {
  const isClickable = !isLoading && isConfigured;

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
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground text-sm">
          {isLoading
            ? "Loading..."
            : !isConfigured
              ? "Not available"
              : statusText}
        </span>
      </div>
      {isLoading ? (
        <Loader2Icon className="text-muted-foreground animate-spin" size={20} />
      ) : isConfigured ? (
        <ChevronRightIcon className="text-muted-foreground" size={20} />
      ) : null}
    </div>
  );
}

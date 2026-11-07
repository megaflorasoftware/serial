import * as React from "react";

export function useMediaQuery(query: string) {
  const media = React.useMemo(
    () => (typeof matchMedia === "undefined" ? null : matchMedia(query)),
    [query],
  );
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      media?.addEventListener("change", onChange);
      return () => media?.removeEventListener("change", onChange);
    },
    [media],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => media?.matches ?? false,
    // Preserve the server's layout during hydration. Subsequent client mounts
    // read the real query immediately instead of mounting the wrong layout.
    () => false,
  );
}

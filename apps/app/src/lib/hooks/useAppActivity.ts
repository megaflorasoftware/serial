import { useEffect, useRef } from "react";
import { useSession } from "~/lib/auth-client";
import { orpcRouterClient } from "~/lib/orpc";
import { createAppActivityRecorder } from "~/lib/data/app-activity";

export function useAppActivity() {
  const { data: session } = useSession();
  const userId = session?.user.id;
  const recorder = useRef<ReturnType<typeof createAppActivityRecorder> | null>(
    null,
  );
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    recorder.current ??= createAppActivityRecorder({
      record: (operationId, signal) =>
        orpcRouterClient.user.recordActivity({ operationId }, { signal }),
      catchUp: (signal) =>
        orpcRouterClient.user.catchUpFeeds(undefined, { signal }),
    });
    if (userId) void recorder.current.start(userId).catch(() => {});
    else recorder.current.stop();
    return () => {
      mounted.current = false;
      // StrictMode repeats setup synchronously. Stop only after an actual unmount.
      queueMicrotask(() => {
        if (!mounted.current) recorder.current?.stop();
      });
    };
  }, [userId]);
}

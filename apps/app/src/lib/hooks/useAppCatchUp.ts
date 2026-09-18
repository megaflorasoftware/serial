import { useEffect } from "react";
import { useSession } from "~/lib/auth-client";
import { orpcRouterClient } from "~/lib/orpc";

export function useAppCatchUp() {
  const { data: session } = useSession();
  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void orpcRouterClient.user
      .catchUpFeeds(undefined, { signal: controller.signal })
      .catch(() => {});
    return () => controller.abort();
  }, [userId]);
}

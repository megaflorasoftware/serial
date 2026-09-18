import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { orpc } from "~/lib/orpc";
import {
  PUBLICATION_SYNC_TOAST,
  showPublicationSyncProgress,
} from "~/lib/data/publication-sync";

/** Mount with the signed-in layout so closing a dialog never loses progress. */
export function PublicationSyncProgress() {
  const observed = useRef<string | null>(null);
  const status = useQuery(
    orpc.atproto.getSyncStatus.queryOptions({
      staleTime: 0,
      meta: { persist: false },
      refetchInterval: (query) => (query.state.data?.pending ? 2000 : false),
    }),
  );
  useEffect(() => {
    const job = status.data;
    if (job?.pending) {
      observed.current = job.runId;
      showPublicationSyncProgress(job);
    } else if (observed.current) {
      // Cancellation, unlink, or a replacement run may change the request ID.
      if (job?.result) showPublicationSyncProgress(job);
      else toast.dismiss(PUBLICATION_SYNC_TOAST);
      observed.current = null;
    }
  }, [status.data]);
  useEffect(
    () => () => {
      toast.dismiss(PUBLICATION_SYNC_TOAST);
    },
    [],
  );
  return null;
}

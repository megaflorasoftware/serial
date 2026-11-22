import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { orpc } from "~/lib/orpc";
import {
  onPublicationSyncStatusChanged,
  PUBLICATION_SYNC_TOAST,
  showPublicationSyncProgress,
} from "~/lib/data/publication-sync";

/** The server announces status changes; this only covers a missed announcement. */
const MISSED_ANNOUNCEMENT_POLL_MS = 15_000;

/** Mount with the signed-in layout so closing a dialog never loses progress. */
export function PublicationSyncProgress() {
  const observed = useRef<string | null>(null);
  const status = useQuery(
    orpc.atproto.getSyncStatus.queryOptions({
      staleTime: 0,
      meta: { persist: false },
      refetchInterval: (query) =>
        query.state.data?.pending ? MISSED_ANNOUNCEMENT_POLL_MS : false,
    }),
  );
  const { refetch } = status;
  useEffect(
    () => onPublicationSyncStatusChanged(() => void refetch()),
    [refetch],
  );
  useEffect(() => {
    const job = status.data;
    if (job?.pending) {
      // Polling a deferred retry must not keep extending its result toast.
      const notification = JSON.stringify(job);
      if (observed.current !== notification) showPublicationSyncProgress(job);
      observed.current = notification;
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

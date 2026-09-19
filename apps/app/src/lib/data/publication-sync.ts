import { toast } from "sonner";
import type { QueryClient } from "@tanstack/react-query";
import type {
  PublicationSyncJobStatus,
  PublicationSyncResult,
} from "~/lib/auth/publication-sync";
import { orpc } from "~/lib/orpc";

/** Explicit saves and consent need feedback even if work finishes before polling starts. */
export async function refreshPublicationSyncProgress(queryClient: QueryClient) {
  try {
    // A read started before the save may still contain the previous request.
    await queryClient.cancelQueries({
      queryKey: orpc.atproto.getSyncStatus.queryKey(),
    });
    const job = await queryClient.fetchQuery(
      orpc.atproto.getSyncStatus.queryOptions({
        staleTime: 0,
        meta: { persist: false },
      }),
    );
    if (job && (!job.pending || (!job.running && job.result)))
      showPublicationSyncProgress(job);
  } catch (error) {
    console.error("Unable to refresh publication sync progress", error);
  }
}

export const PUBLICATION_SYNC_TOAST = "publication-subscription-sync";
export function publicationSyncMessage(result: PublicationSyncResult) {
  if (result.status === "skipped") return "Publication sync is turned off.";
  return `Subscriptions synced: ${result.imported} imported, ${result.exported} exported, ${result.inactive} added inactive, ${result.removed} removed${result.skipped ? `, ${result.skipped} skipped` : ""}${result.failed ? `, ${result.failed} failed` : ""}${result.deferred ? `, ${result.deferred} pending the next sync` : ""}.`;
}

/** Progress observes persisted server work; it never occupies the global loading state. */
export function showPublicationSyncProgress(job: PublicationSyncJobStatus) {
  if (job.pending && (job.running || !job.result)) {
    const progress = job.progress;
    toast.loading(
      progress?.total
        ? `Syncing subscriptions: ${progress.completed} of ${progress.total}`
        : "Syncing subscriptions…",
      {
        id: PUBLICATION_SYNC_TOAST,
        description: "You can keep using Serial or close the app.",
      },
    );
  } else if (job.result) {
    const notify =
      job.result.status === "partial" ? toast.warning : toast.success;
    notify(publicationSyncMessage(job.result), {
      id: PUBLICATION_SYNC_TOAST,
      description: undefined,
      duration: 5000,
    });
  } else toast.dismiss(PUBLICATION_SYNC_TOAST);
}

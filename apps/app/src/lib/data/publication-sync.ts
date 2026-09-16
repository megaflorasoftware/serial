import { toast } from "sonner";
import { loadingActor } from "./loading-machine";
import type { PublicationSyncResult } from "~/lib/auth/publication-sync";
import { orpcRouterClient } from "~/lib/orpc";

let pending: Promise<void> | undefined;
function waitForIdle() {
  if (loadingActor.getSnapshot().matches("idle")) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.unsubscribe();
      reject(
        new Error(
          "Another import or refresh is still running. Subscriptions will sync on the next Feed refresh.",
        ),
      );
    }, 120_000);
    const subscription = loadingActor.subscribe((snapshot) => {
      if (!snapshot.matches("idle")) return;
      clearTimeout(timeout);
      subscription.unsubscribe();
      resolve();
    });
  });
}
export function publicationSyncMessage(result: PublicationSyncResult) {
  if (result.status === "busy")
    return "Publication sync is already running. Try again when it finishes.";
  if (result.status === "skipped") return "Publication sync is turned off.";
  return `Subscriptions synced: ${result.imported} imported, ${result.exported} exported, ${result.inactive} added inactive, ${result.removed} removed${result.failed ? `, ${result.failed} failed` : ""}${result.deferred ? `, ${result.deferred} pending the next sync` : ""}.`;
}
/** One operation per browser, shared by Save and consent return. */
export function requestPublicationSync(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    const runId = crypto.randomUUID();
    try {
      await waitForIdle();
      loadingActor.send({ type: "PUBLICATION_SYNC_START", runId });
      const result = await orpcRouterClient.atproto.syncSubscriptions({
        runId,
      });
      if (result.status === "partial" || result.status === "busy")
        toast.warning(publicationSyncMessage(result));
      else toast.success(publicationSyncMessage(result));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't sync publication subscriptions.",
      );
    } finally {
      loadingActor.send({ type: "PUBLICATION_SYNC_COMPLETE", runId });
    }
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}

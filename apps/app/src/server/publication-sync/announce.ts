import { getUserChannel } from "~/server/api/channels";
import { publisher } from "~/server/api/publisher";
import { logError } from "~/server/logger";

/**
 * Tells the user's open clients that the persisted sync status changed, so
 * they read it again instead of polling for it. A lost notice only delays the
 * interface until its fallback poll.
 */
export async function announceSyncStatus(userId: string) {
  try {
    await publisher.publish(getUserChannel(userId), {
      source: "publication-sync",
      chunk: { type: "status-changed" },
    });
  } catch (error) {
    logError("[publication-sync] status announcement failed", error);
  }
}

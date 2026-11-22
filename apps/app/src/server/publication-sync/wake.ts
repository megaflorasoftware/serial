import { wakePublicationSyncJobs } from "./jobs";
import type { db } from "~/server/db";

/**
 * Starts the run a Feed change requested instead of leaving it for the
 * per-minute task. Call it once the request has committed, never inside its
 * transaction. It returns at once and does not wait for the run.
 */
export function wakeRequestedSync(database: typeof db, requested: boolean) {
  if (requested) wakePublicationSyncJobs(database);
}

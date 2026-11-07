import { syncPublicationSubscriptions } from "./engine";
import type { RssPublishedChunk } from "~/lib/rss";
import type { db as Database } from "~/server/db";
import { logError } from "~/server/logger";

/** The winning RSS attempt owns progress; a sync failure never prevents item fetching. */
export async function syncBeforeFeedRefresh(input: {
  database: typeof Database;
  userId: string;
  channel: string;
  nextRefreshAt: Date;
  publish: (channel: string, chunk: RssPublishedChunk) => Promise<void>;
  sync?: typeof syncPublicationSubscriptions;
}) {
  let started = false;
  try {
    await (input.sync ?? syncPublicationSubscriptions)({
      database: input.database,
      userId: input.userId,
      onProgress: async (progress) => {
        if (!started) {
          await input.publish(input.channel, {
            type: "refresh-start",
            totalFeeds: 0,
            nextRefreshAt: input.nextRefreshAt,
          });
          started = true;
        }
        await input.publish(input.channel, {
          type: "refresh-progress",
          completed: progress.completed,
          total: progress.total + 1,
        });
      },
    });
  } catch (error) {
    logError("[publication-sync] pre-refresh sync failed", error);
  }
  return started;
}

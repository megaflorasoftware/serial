import { eq, sql } from "drizzle-orm";
import type { BenchmarkDatabase } from "./database";
import { feedItemPageImages, feedItems, feeds } from "~/server/db/schema";
import { refreshPageImages } from "~/server/rss/refreshPageImages";

/** Reuse the ingest history to exercise eight due repairs among already checked rows. */
export async function createPageImageWorkload(database: BenchmarkDatabase) {
  const feed = (await database
    .select()
    .from(feeds)
    .where(eq(feeds.userId, "ingest-benchmark"))
    .get())!;
  await database.run(sql`INSERT INTO serial_feed_item_page_image (item_id, feed_id, page_url, next_check_at)
    SELECT id, feed_id, url, 8640000000000000 FROM serial_feed_item WHERE feed_id = ${feed.id}
    ON CONFLICT(item_id) DO UPDATE SET next_check_at = 8640000000000000`);
  const batch = await database
    .select({ id: feedItems.id })
    .from(feedItems)
    .where(eq(feedItems.feedId, feed.id))
    .limit(8);
  let revision = 0;
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    async prepare() {
      requests = 0;
      revision++;
      for (const { id } of batch) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await database
          .update(feedItemPageImages)
          .set({ nextCheckAt: new Date(0) })
          .where(eq(feedItemPageImages.itemId, id));
      }
    },
    run() {
      return refreshPageImages(database, feed, async (url) => {
        requests++;
        return {
          url,
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          text: `<meta property="og:image" content="https://example.com/og-${revision}.png">`,
        };
      });
    },
  };
}

import { JSDOM } from "jsdom";
import { openGraphImageUrl } from "@serial/bookmark-capture";
import { readFeedHttp } from "./feedHttp";
import type { ItemObservation } from "./itemObservation";
import { workerPool } from "~/lib/workerPool";

export const PAGE_IMAGE_BATCH_SIZE = 8;
export const PAGE_IMAGE_CONCURRENCY = 2;

async function fetchPageImage(url: string, readPage: typeof readFeedHttp) {
  if (
    !URL.canParse(url) ||
    !["https:", "http:"].includes(new URL(url).protocol)
  )
    return undefined;
  try {
    const response = await readPage(url, {
      maxBodyBytes: 256 * 1024,
      totalDurationMs: 3_000,
    });
    if (!response.ok) return undefined;
    const dom = new JSDOM(response.text);
    try {
      return openGraphImageUrl(dom.window.document, response.url) ?? undefined;
    } finally {
      dom.window.close();
    }
  } catch {
    return undefined;
  }
}

/** Optional enrichment during content ingest. Failure never creates retry work. */
export async function enrichObservationImages(
  observations: ItemObservation[],
  readPage: typeof readFeedHttp = readFeedHttp,
) {
  const candidates = observations
    .filter((item) => !item.thumbnail && /^https?:\/\//.test(item.url))
    .slice(0, PAGE_IMAGE_BATCH_SIZE);
  const images = new Map<ItemObservation, string | undefined>();
  for await (const result of workerPool(
    candidates,
    PAGE_IMAGE_CONCURRENCY,
    async (item) => ({ item, image: await fetchPageImage(item.url, readPage) }),
  ))
    images.set(result.item, result.image);
  return observations.map((item) =>
    images.has(item) ? { ...item, pageImageUrl: images.get(item) } : item,
  );
}

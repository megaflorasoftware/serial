import { MemoryPublisher } from "@orpc/experimental-publisher/memory";
import type {
  GetByViewChunk,
  GetItemsByCategoryIdChunk,
  GetItemsByFeedChunk,
  GetItemsByVisibilityChunk,
  RevalidateViewChunk,
} from "./routers/initialRouter";
import { env } from "~/env";

// Union of all chunk types that can be published
export type PublishedChunk =
  | { source: "initial"; chunk: GetByViewChunk }
  | { source: "revalidate"; chunk: RevalidateViewChunk }
  | { source: "visibility"; chunk: GetItemsByVisibilityChunk }
  | { source: "feed"; chunk: GetItemsByFeedChunk }
  | { source: "category"; chunk: GetItemsByCategoryIdChunk }
  | { source: "new-data"; chunk: GetByViewChunk };

// ---------------------------------------------------------------------------
// Publisher — picks the best available Redis backend at startup.
//
// - UpstashRedisPublisher  (KV_STORE='upstash')
// - IORedisPublisher       (KV_STORE='ioredis')
// - MemoryPublisher        (KV_STORE='none', default)
// ---------------------------------------------------------------------------

const RESUME_RETENTION_SECONDS = 60 * 2;
const REDIS_KEY_PREFIX = "serial:pub:";

type PublisherChannelMap = Record<string, PublishedChunk>;

async function createPublisher() {
  const kvStore = env.KV_STORE;

  if (kvStore === "upstash") {
    const { Redis } = await import("@upstash/redis");
    const { UpstashRedisPublisher } =
      await import("@orpc/experimental-publisher/upstash-redis");

    const redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL!,
      token: env.UPSTASH_REDIS_REST_TOKEN!,
    });

    console.log("[publisher] Using UpstashRedisPublisher");
    return new UpstashRedisPublisher<PublisherChannelMap>(redis, {
      resumeRetentionSeconds: RESUME_RETENTION_SECONDS,
      prefix: REDIS_KEY_PREFIX,
    });
  }

  if (kvStore === "ioredis") {
    const { default: Redis } = await import("ioredis");
    const { IORedisPublisher } =
      await import("@orpc/experimental-publisher/ioredis");

    const commander = new Redis(env.REDIS_URL!);
    const listener = new Redis(env.REDIS_URL!, { lazyConnect: true });

    console.log("[publisher] Using IORedisPublisher");
    return new IORedisPublisher<PublisherChannelMap>({
      commander,
      listener,
      resumeRetentionSeconds: RESUME_RETENTION_SECONDS,
      prefix: REDIS_KEY_PREFIX,
    });
  }

  console.log("[publisher] Using MemoryPublisher (KV_STORE is 'none')");
  return new MemoryPublisher<PublisherChannelMap>({
    resumeRetentionSeconds: RESUME_RETENTION_SECONDS,
  });
}

export const publisher = await createPublisher();

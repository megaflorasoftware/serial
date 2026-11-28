import type { readFeedHttp } from "~/server/rss/feedHttp";

export const DISCOVERY_PRIMARY_REQUEST_MS = 5_000;
export const DISCOVERY_GUESS_REQUEST_MS = 1_000;
export const DISCOVERY_GUESS_TOTAL_MS = 2_000;
export const DISCOVERY_PUBLICATION_HINT_MS = 1_000;

/** A probing phase starts its shared clock on its first request, not page load. */
export function withDiscoveryReadBudget(
  read: typeof readFeedHttp,
  totalDurationMs: number,
  requestDurationMs = totalDurationMs,
): typeof readFeedHttp {
  let deadline: number | undefined;
  return (url, options) => {
    deadline ??= Date.now() + totalDurationMs;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0)
      return Promise.reject(new Error("Discovery probing budget reached"));
    return read(url, {
      ...options,
      totalDurationMs: Math.min(
        options?.totalDurationMs ?? requestDurationMs,
        requestDurationMs,
        remainingMs,
      ),
    });
  };
}

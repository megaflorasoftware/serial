import type { ConnectionState } from "~/lib/data/atoms";

export type ReaderChunkPreloadStatus = "idle" | "loading" | "loaded";

/**
 * The reader route ships as its own code-split chunk. After a deploy the
 * page can boot from new HTML while the previous service worker still
 * controls it, so the new reader chunk is in neither the old precache nor
 * the runtime script cache until something imports it. Fetch it as soon as
 * there is offline-readable content to show and a live connection to fetch
 * it over. A failed import poisons the route for the session (the router
 * only recovers through a page reload), so the attempt must never start
 * while disconnected.
 */
export function shouldPreloadReaderChunk(input: {
  connectionState: ConnectionState;
  hasOfflineContent: boolean;
  status: ReaderChunkPreloadStatus;
}) {
  return (
    input.status === "idle" &&
    input.hasOfflineContent &&
    input.connectionState === "connected"
  );
}

export function hasAnyKey(record: Record<string, unknown>) {
  for (const key in record) {
    if (Object.hasOwn(record, key)) return true;
  }
  return false;
}

// Session-scoped: the router caches a loaded chunk, and a failed load cannot
// be retried without a reload, so one attempt per page lifetime is all that
// is useful.
let status: ReaderChunkPreloadStatus = "idle";

export function getReaderChunkPreloadStatus() {
  return status;
}

export function setReaderChunkPreloadStatus(next: ReaderChunkPreloadStatus) {
  status = next;
}

export function resetReaderChunkPreloadForTests() {
  status = "idle";
}

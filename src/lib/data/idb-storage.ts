import { del, get, set } from "idb-keyval";
import type { PersistStorage, StorageValue } from "zustand/middleware";

/**
 * Write throttle in milliseconds. During rapid state updates (e.g. SSE chunk
 * processing), we buffer writes so that at most one IDB write happens per
 * interval. The latest value always wins.
 */
const WRITE_THROTTLE_MS = 2000;

/**
 * Creates an IndexedDB-backed storage adapter for Zustand's persist middleware.
 *
 * Uses `idb-keyval` which relies on the structured clone algorithm, so Date,
 * Set, Map, ArrayBuffer, etc. are preserved without JSON serialization.
 *
 * Writes are throttled to avoid hammering IDB during high-frequency state
 * updates (e.g. initial SSE chunk processing). A `visibilitychange` listener
 * flushes any pending write when the page is backgrounded or closed.
 */
export function createIDBStorage<T>(): PersistStorage<T> {
  // No-op storage for SSR — IndexedDB doesn't exist on the server
  if (typeof window === "undefined") {
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }

  let writeTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingName: string | null = null;
  let pendingValue: StorageValue<T> | null = null;

  const flush = () => {
    writeTimeout = null;
    if (pendingName !== null && pendingValue !== null) {
      void set(pendingName, pendingValue);
      pendingName = null;
      pendingValue = null;
    }
  };

  // Flush on page hide so the latest state is persisted before the tab
  // is discarded or backgrounded.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (writeTimeout !== null) {
        clearTimeout(writeTimeout);
      }
      flush();
    }
  });

  return {
    getItem: async (name: string) => {
      return (await get<StorageValue<T>>(name)) ?? null;
    },

    setItem: (name: string, value: StorageValue<T>) => {
      pendingName = name;
      pendingValue = value;
      if (writeTimeout === null) {
        writeTimeout = setTimeout(flush, WRITE_THROTTLE_MS);
      }
    },

    removeItem: async (name: string) => {
      if (writeTimeout !== null) {
        clearTimeout(writeTimeout);
        writeTimeout = null;
      }
      pendingName = null;
      pendingValue = null;
      await del(name);
    },
  };
}

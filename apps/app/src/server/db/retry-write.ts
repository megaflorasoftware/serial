import { setTimeout } from "node:timers/promises";

/** Local SQLite rejects overlapping writers instead of waiting for the lock. */
async function retryBusyWrite<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Retry only after the previous transaction has rolled back.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      return await write();
    } catch (error) {
      if (
        attempt >= 4 ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "SQLITE_BUSY"
      )
        throw error;
      // Back off before attempting to acquire the same write lock again.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await setTimeout(10 * 2 ** attempt);
    }
  }
}

const pendingWrites = new WeakMap<object, Promise<unknown>>();

/** Queue local file writes; remote libSQL manages its own write concurrency. */
export async function runDatabaseWrite<T>(
  database: { $client?: { protocol: string } },
  write: () => Promise<T>,
): Promise<T> {
  if (database.$client?.protocol !== "file") return retryBusyWrite(write);
  const previous = pendingWrites.get(database) ?? Promise.resolve();
  const result = previous.then(() => retryBusyWrite(write));
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingWrites.set(database, settled);
  try {
    return await result;
  } finally {
    if (pendingWrites.get(database) === settled) pendingWrites.delete(database);
  }
}

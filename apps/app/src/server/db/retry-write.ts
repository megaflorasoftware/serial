import { setTimeout } from "node:timers/promises";

/** Local SQLite rejects overlapping writers instead of waiting for the lock. */
export async function retryBusyWrite<T>(write: () => Promise<T>): Promise<T> {
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

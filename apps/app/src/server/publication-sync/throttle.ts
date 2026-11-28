/**
 * Runs `action` at most once per interval. A request that arrives sooner is
 * not lost: one trailing run follows when the interval ends, so the latest
 * state is always delivered.
 */
export function throttleWithTrailing(
  action: () => Promise<void>,
  intervalMs: number,
  onError: (error: unknown) => void,
) {
  let ranAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    ranAt = Date.now();
    return action();
  };
  return {
    async request() {
      // A trailing run is already due and will deliver this change too.
      if (trailing) return;
      const wait = ranAt + intervalMs - Date.now();
      if (wait <= 0) return run();
      trailing = setTimeout(() => {
        trailing = undefined;
        run().catch(onError);
      }, wait);
    },
    /** Drops a trailing run the caller is about to make redundant. */
    cancel() {
      clearTimeout(trailing);
      trailing = undefined;
    },
  };
}

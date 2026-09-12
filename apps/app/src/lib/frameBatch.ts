/**
 * Buffers items and hands them to `flush` once per animation frame, so a burst
 * of stream chunks decoded from the same network read costs one store write
 * and one render instead of one per chunk. Where animation frames do not exist
 * (unit tests) a zero-delay timer stands in. `flush()` drains synchronously;
 * call it before any event that must observe every buffered item.
 *
 * A `flush` callback that throws inside a frame has no caller to reject, so
 * the error is held and rethrown from the next `push` or `flush`. That keeps
 * a failed apply visible to the stream loop instead of an uncaught frame error.
 */
export function createFrameBatch<T>(flush: (items: T[]) => void) {
  let buffer: T[] = [];
  let pending: (() => void) | null = null;
  let failure: unknown = null;
  let failed = false;

  const rethrowFailure = () => {
    if (!failed) return;
    const error = failure;
    failed = false;
    failure = null;
    throw error;
  };

  const drain = () => {
    pending = null;
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    flush(items);
  };

  const drainInFrame = () => {
    try {
      drain();
    } catch (error) {
      failed = true;
      failure = error;
    }
  };

  const schedule = () => {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(drainInFrame);
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(drainInFrame, 0);
    return () => clearTimeout(id);
  };

  return {
    push(item: T) {
      buffer.push(item);
      pending ??= schedule();
      rethrowFailure();
    },
    flush() {
      rethrowFailure();
      pending?.();
      drain();
    },
  };
}

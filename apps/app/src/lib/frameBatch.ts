/**
 * Buffers items and hands them to `flush` once per animation frame, so a burst
 * of stream chunks decoded from the same network read costs one store write
 * and one render instead of one per chunk. Where animation frames do not exist
 * (unit tests) a zero-delay timer stands in. `flush()` drains synchronously;
 * call it before any event that must observe every buffered item.
 */
export function createFrameBatch<T>(flush: (items: T[]) => void) {
  let buffer: T[] = [];
  let pending: (() => void) | null = null;

  const drain = () => {
    pending = null;
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];
    flush(items);
  };

  const schedule = () => {
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(drain);
      return () => cancelAnimationFrame(id);
    }
    const id = setTimeout(drain, 0);
    return () => clearTimeout(id);
  };

  return {
    push(item: T) {
      buffer.push(item);
      pending ??= schedule();
    },
    flush() {
      pending?.();
      drain();
    },
  };
}

/**
 * Processes items through a worker pool with fixed concurrency.
 * As soon as one worker finishes, it picks up the next item.
 * Results are yielded as they complete (not in original order).
 */
export async function* workerPool<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<TResult>,
): AsyncGenerator<TResult> {
  const queue = [...items];
  const active = new Map<
    Promise<{ result: TResult; promise: Promise<unknown> }>,
    T
  >();

  // Helper to create a trackable promise
  const createWorkerPromise = (item: T) => {
    const promise: Promise<{ result: TResult; promise: Promise<unknown> }> =
      worker(item).then((result) => ({ result, promise }));
    return promise;
  };

  // Start initial batch of workers
  while (active.size < concurrency && queue.length > 0) {
    const item = queue.shift()!;
    const promise = createWorkerPromise(item);
    active.set(promise, item);
  }

  // Process until all complete
  while (active.size > 0) {
    const completed = await Promise.race(active.keys());
    const { result, promise } = await completed;
    active.delete(
      promise as Promise<{ result: TResult; promise: Promise<unknown> }>,
    );
    yield result;

    // Start next item if queue has more
    if (queue.length > 0) {
      const item = queue.shift()!;
      const newPromise = createWorkerPromise(item);
      active.set(newPromise, item);
    }
  }
}

/**
 * Runs up to `concurrency` items at once, like `workerPool`, but yields the
 * results in the order of `items`. An item starts only when the one
 * `concurrency` places before it has been taken, so results never pile up
 * ahead of a slow consumer, and a consumer that stops early starts nothing
 * more.
 */
export async function* orderedWorkerPool<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<TResult>,
): AsyncGenerator<TResult> {
  const started: Array<Promise<TResult>> = [];
  let next = 0;
  try {
    for (; next < items.length; next++) {
      while (started.length < Math.min(items.length, next + concurrency))
        started.push(worker(items[started.length]!));
      yield await started[next]!;
    }
  } finally {
    // Work the consumer no longer takes may still fail; nobody awaits it.
    for (const pending of started.slice(next + 1))
      pending.catch(() => undefined);
  }
}

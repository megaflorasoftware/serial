/** One operation per authenticated user and layout mount, even when effect setup repeats. */
export function createAppActivityRecorder(dependencies: {
  record: (signal: AbortSignal) => Promise<unknown>;
  catchUp: (signal: AbortSignal) => Promise<unknown>;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  let current:
    | { userId: string; controller: AbortController; work: Promise<void> }
    | undefined;
  return {
    start(userId: string) {
      if (current?.userId === userId) return current.work;
      current?.controller.abort();
      const controller = new AbortController();
      const work = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (controller.signal.aborted) return;
          try {
            await dependencies.record(controller.signal);
            break;
          } catch (error) {
            if (controller.signal.aborted) return;
            if (attempt === 2) throw error;
            await (
              dependencies.wait ??
              ((milliseconds) =>
                new Promise((resolve) => setTimeout(resolve, milliseconds)))
            )(1000 * 2 ** attempt);
          }
        }
        if (!controller.signal.aborted)
          await dependencies.catchUp(controller.signal);
      })();
      current = { userId, controller, work };
      return work;
    },
    stop() {
      current?.controller.abort();
      current = undefined;
    },
  };
}

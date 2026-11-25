import { logError } from "~/server/logger";

/** How soon another run starts after one that left work due or was woken. */
const RERUN_DELAY_MS = 1100;

/**
 * A best-effort way to start persisted background work in this process at
 * once, one run per target at a time. A wake during a run starts another once
 * it ends, as does a run that resolves to `true` because more work is due.
 * Scheduled tasks recover whatever a restart interrupts.
 */
export function createInProcessWake<TTarget extends object>(
  label: string,
  run: (target: TTarget) => Promise<boolean>,
) {
  const runs = new WeakMap<TTarget, { again: boolean }>();
  const wake = (target: TTarget) => {
    const current = runs.get(target);
    if (current) {
      current.again = true;
      return;
    }
    const started = { again: false };
    runs.set(target, started);
    void run(target)
      .catch((error: unknown) => {
        logError(`[${label}] worker failed`, error);
        return false;
      })
      .then((more) => {
        runs.delete(target);
        if (more || started.again)
          setTimeout(() => wake(target), RERUN_DELAY_MS).unref();
      });
  };
  return wake;
}

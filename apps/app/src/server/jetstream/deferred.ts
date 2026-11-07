/** A recovery still in backoff; the failure that caused it was reported when it happened. */
export class RecoveryDeferredError extends Error {
  constructor() {
    super("Publication recovery is waiting to retry");
  }
}

export function isRecoveryDeferred(error: unknown) {
  return error instanceof RecoveryDeferredError;
}

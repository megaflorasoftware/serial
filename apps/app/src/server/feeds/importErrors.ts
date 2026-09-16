/** Incomplete verification is retryable; a completed ambiguous match is not. */
export class FeedImportDeferredError extends Error {
  constructor(
    message = "Feed discovery could not finish. Please try importing this Feed again later.",
    readonly retryAt = new Date(Date.now() + 60_000),
  ) {
    super(message);
  }
}

export class FeedImportSkippedError extends Error {
  constructor() {
    super(
      "Skipped: this site may already be subscribed, but its Feed origins could not be verified as the same articles.",
    );
  }
}

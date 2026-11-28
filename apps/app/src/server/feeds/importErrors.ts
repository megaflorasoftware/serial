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

/**
 * The publication will not come back as it stands: it was deleted, its
 * repository no longer resolves, its record is invalid, or it cannot join the
 * Feed it belongs to. Only a change to the publication makes a retry worthwhile.
 */
export class PublicationGoneError extends Error {}

/** Retrying cannot succeed. Rate limits, timeouts and outages never count. */
export function publicationIsGone(error: unknown) {
  return error instanceof PublicationGoneError;
}

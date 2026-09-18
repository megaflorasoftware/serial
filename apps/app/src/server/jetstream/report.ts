import { captureException } from "../logger";
import { errorChain, streamFailure } from "./protocol";

const reported = new WeakSet<object>();

/** One report per error object, including errors retried inside the SDK. */
export function createStreamReporter(service: string, signal?: AbortSignal) {
  return (error: unknown, operation: string) => {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      return;
    const chain = errorChain(error);
    if (chain.some((entry) => reported.has(entry))) return;
    for (const entry of chain) reported.add(entry);
    // Transport error messages/cause chains can contain authenticated URLs or record bodies.
    const status = streamFailure(error)?.status;
    captureException(new Error(`Jetstream ${operation} failed`), {
      operation,
      service,
      status,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  };
}

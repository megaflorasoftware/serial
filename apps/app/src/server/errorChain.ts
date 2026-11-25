/** An error and each `cause` it wraps, outermost first. */
export function errorChain(error: unknown): object[] {
  const chain: object[] = [];
  const seen = new Set<object>();
  while (error !== null && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    chain.push(error);
    error = "cause" in error ? error.cause : undefined;
  }
  return chain;
}

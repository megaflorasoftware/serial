function sameField(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (previous instanceof Date && next instanceof Date) {
    return Object.is(previous.getTime(), next.getTime());
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    return (
      previous.length === next.length &&
      previous.every((value, index) => sameField(value, next[index]))
    );
  }
  return false;
}

/** Repeated wire snapshots must not replace unchanged flat entity records. */
export function retainEqualEntity<T extends object>(
  previous: T | undefined,
  next: T,
): T {
  if (!previous || previous === next) return next;
  const previousFields = Object.entries(previous);
  const nextFields = next as Record<string, unknown>;
  if (previousFields.length !== Object.keys(next).length) return next;
  return previousFields.every(
    ([key, value]) =>
      Object.hasOwn(next, key) && sameField(value, nextFields[key]),
  )
    ? previous
    : next;
}

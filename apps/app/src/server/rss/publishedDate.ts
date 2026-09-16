/** Keep undated items stable across refreshes at the database's second precision. */
export function resolveItemDate(
  date: Date,
  existing: Date | undefined,
  firstSeen: Date,
) {
  if (Number.isFinite(date.getTime())) return date;
  if (existing && Number.isFinite(existing.getTime())) return existing;
  return new Date(Math.floor(firstSeen.getTime() / 1000) * 1000);
}

/** Decide from changes since the last successful observation, never set equality. */
export function planPublicationSync(input: {
  localFeedId: number | null;
  previousFeedId: number | null;
  remotePresent: boolean;
  previousRemotePresent: boolean;
  known: boolean;
  importEnabled: boolean;
  exportEnabled: boolean;
  importBaseline: boolean;
  exportBaseline: boolean;
}): "import" | "export" | "remove-local" | "remove-remote" | "observe" {
  const localRemoved =
    input.previousFeedId !== null && input.localFeedId === null;
  const remoteRemoved = input.previousRemotePresent && !input.remotePresent;
  if (
    localRemoved &&
    input.remotePresent &&
    input.exportEnabled &&
    !input.exportBaseline
  )
    return "remove-remote";
  if (
    remoteRemoved &&
    input.localFeedId !== null &&
    input.localFeedId === input.previousFeedId &&
    input.importEnabled &&
    !input.importBaseline
  )
    return "remove-local";
  if (
    input.remotePresent &&
    input.localFeedId === null &&
    input.importEnabled &&
    (input.importBaseline || !input.known || !input.previousRemotePresent)
  )
    return "import";
  if (
    !input.remotePresent &&
    input.localFeedId !== null &&
    input.exportEnabled &&
    (input.exportBaseline ||
      !input.known ||
      input.localFeedId !== input.previousFeedId)
  )
    return "export";
  return "observe";
}

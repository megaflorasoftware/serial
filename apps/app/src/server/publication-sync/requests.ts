import { randomUUID } from "node:crypto";
import type { PublicationSyncResult } from "~/lib/auth/publication-sync";

export function newPublicationSyncRequest(enabled: boolean) {
  return {
    subscriptionRequestId: randomUUID(),
    subscriptionNextAttemptAt: enabled ? new Date() : null,
    subscriptionJobProgress: null,
    subscriptionJobResult: null,
  };
}

export function nextPublicationSyncAttempt(result: PublicationSyncResult) {
  const retryTimes = [
    ...(result.retryAt ? [new Date(result.retryAt).getTime()] : []),
    ...(result.deferred && !result.retryAt ? [Date.now() + 1000] : []),
    ...(result.status === "busy" ? [Date.now() + 60_000] : []),
  ];
  return retryTimes.length
    ? new Date(Math.max(Date.now() + 1000, Math.min(...retryTimes)))
    : null;
}

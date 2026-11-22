/**
 * Tells once per outage when it has outlasted its grace period. Deploys and
 * brief drops reconnect within it and cost nothing; a longer outage hands the
 * origins the stream covered back to polling.
 */
export function createOutageWatch(
  graceMs: number,
  now: () => number = Date.now,
) {
  let since: number | undefined;
  let handedOver = false;
  return {
    connected() {
      since = undefined;
      handedOver = false;
    },
    /** True the first time a failed attempt finds the outage past its grace period. */
    outlastedGrace() {
      since ??= now();
      if (handedOver || now() - since < graceMs) return false;
      handedOver = true;
      return true;
    },
  };
}

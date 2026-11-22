/**
 * Tells once per outage when it has outlasted its grace period. Deploys and
 * brief drops deliver again within it and cost nothing; a longer outage hands
 * the origins the stream covered back to polling. An outage ends when the
 * stream delivers a batch, not when a socket opens, so a connection that keeps
 * opening and dropping still runs out of grace.
 */
export function createOutageWatch(
  graceMs: number,
  now: () => number = Date.now,
) {
  let since: number | undefined;
  let handedOver = false;
  return {
    delivered() {
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

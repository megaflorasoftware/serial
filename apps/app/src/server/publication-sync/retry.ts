const FIRST_DELAY_MS = 60_000;
const LONGEST_DELAY_MS = 24 * 60 * 60 * 1000;
const GIVE_UP_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** The wait after failure number `attempts`: doubling from a minute, capped at a day. */
export function retryDelayMs(attempts: number) {
  return Math.min(LONGEST_DELAY_MS, FIRST_DELAY_MS * 2 ** (attempts - 1));
}

/**
 * The waits already served before failure number `attempts`. They bound how
 * long the work has been failing, so no first-failure time needs storing.
 */
function waitedMs(attempts: number) {
  let waited = 0;
  for (
    let failure = 1;
    failure < attempts && waited < GIVE_UP_AFTER_MS;
    failure++
  )
    waited += retryDelayMs(failure);
  return waited;
}

/**
 * When to try again after failure number `attempts` of work that may recover,
 * such as a website that is down. Null once 14 days of retries are spent.
 */
export function nextRetryAt(attempts: number, now = new Date()) {
  return waitedMs(attempts) >= GIVE_UP_AFTER_MS
    ? null
    : new Date(now.getTime() + retryDelayMs(attempts));
}

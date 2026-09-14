/**
 * A navigation's resulting client is reserved until its document commits,
 * so a background revalidation that resolves before the cached document has
 * committed cannot address the page yet. Poll briefly for the client to
 * appear rather than leaving that page on a shell whose session has ended.
 */
export const RESULTING_CLIENT_POLL_MS = 100;
export const RESULTING_CLIENT_WAIT_MS = 10_000;

type WaitForClientOptions<TClient> = {
  getClient: () => Promise<TClient | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function sleepFor(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForResultingClient<TClient>({
  getClient,
  now = Date.now,
  sleep = sleepFor,
}: WaitForClientOptions<TClient>): Promise<TClient | undefined> {
  const deadline = now() + RESULTING_CLIENT_WAIT_MS;
  let client = await getClient();
  while (!client && now() < deadline) {
    // Each poll depends on the previous one coming back empty.
    // oxlint-disable-next-line react-doctor/async-await-in-loop
    await sleep(RESULTING_CLIENT_POLL_MS);
    // oxlint-disable-next-line react-doctor/async-await-in-loop
    client = await getClient();
  }
  return client;
}

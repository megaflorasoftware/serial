import { describe, expect, it, vi } from "vitest";
import {
  RESULTING_CLIENT_POLL_MS,
  RESULTING_CLIENT_WAIT_MS,
  waitForResultingClient,
} from "~/lib/pwa/resulting-client";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: vi.fn((ms: number) => {
      time += ms;
      return Promise.resolve();
    }),
  };
}

describe("waitForResultingClient", () => {
  it("returns an already committed client without sleeping", async () => {
    const clock = fakeClock();
    const client = { id: "page" };

    await expect(
      waitForResultingClient({
        getClient: () => Promise.resolve(client),
        ...clock,
      }),
    ).resolves.toBe(client);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("polls until the reserved client commits", async () => {
    const clock = fakeClock();
    const client = { id: "page" };
    const getClient = vi
      .fn<() => Promise<{ id: string } | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(client);

    await expect(waitForResultingClient({ getClient, ...clock })).resolves.toBe(
      client,
    );
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledWith(RESULTING_CLIENT_POLL_MS);
  });

  it("gives up once the wait budget is spent", async () => {
    const clock = fakeClock();
    const getClient = vi.fn(() => Promise.resolve(undefined));

    await expect(
      waitForResultingClient({ getClient, ...clock }),
    ).resolves.toBeUndefined();
    expect(clock.sleep).toHaveBeenCalledTimes(
      RESULTING_CLIENT_WAIT_MS / RESULTING_CLIENT_POLL_MS,
    );
  });
});

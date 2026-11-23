import { afterEach, describe, expect, it } from "vitest";
import { StreamFailure } from "~/server/jetstream/protocol";
import {
  forgetOutage,
  hostUnreachable,
  recentOutage,
  rememberOutage,
} from "~/server/jetstream/reachability";

const SERVICE = "https://jetstream.example.com";
afterEach(() => forgetOutage(SERVICE));

describe("an unreachable stream host", () => {
  it.each([
    ["a connection that failed or timed out", new StreamFailure("connection")],
    ["a connection the host dropped", new StreamFailure("connection-closed")],
    ["a server error", new StreamFailure("connection", 503)],
    ["a replay server error", new StreamFailure("replay-http", 502)],
    [
      "a failure wrapped by its caller",
      new Error("recovery", { cause: new StreamFailure("connection") }),
    ],
  ])("is %s", (_, error) => {
    expect(hostUnreachable(error)).toBe(true);
  });

  it.each([
    ["a refused position", new StreamFailure("cursor-expired", 400)],
    ["a rate limit", new StreamFailure("connection", 429)],
    [
      "a server error with its own retry delay",
      new StreamFailure("connection", 503, 75_000),
    ],
    [
      "a boundary this server stopped waiting for",
      new StreamFailure("boundary"),
    ],
    ["a buffer this server overflowed", new StreamFailure("live-buffer")],
    ["a lease this server lost", new StreamFailure("connection-ownership")],
    ["a PDS failure", new Error("Invalid publication record")],
  ])("is not %s", (_, error) => {
    expect(hostUnreachable(error)).toBe(false);
  });
});

describe("a remembered outage", () => {
  const failure = new StreamFailure("connection");

  it("answers with the failure that found it until a contact succeeds", () => {
    expect(recentOutage(SERVICE, 0)).toBeUndefined();
    rememberOutage(SERVICE, failure, 0);
    expect(recentOutage(SERVICE, 1)?.failure).toBe(failure);
    expect(recentOutage("https://other.example.com", 1)).toBeUndefined();
    forgetOutage(SERVICE);
    expect(recentOutage(SERVICE, 1)).toBeUndefined();
  });

  it("lapses after two minutes, and a later failure starts it over", () => {
    rememberOutage(SERVICE, failure, 0);
    expect(recentOutage(SERVICE, 119_999)).toBeDefined();
    expect(recentOutage(SERVICE, 120_000)).toBeUndefined();
    rememberOutage(SERVICE, failure, 200_000);
    expect(recentOutage(SERVICE, 200_001)).toBeDefined();
  });
});

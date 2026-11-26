import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryPausedError,
  withDiscoveryPacing,
} from "~/server/http/pacing";
import { SERIAL_USER_AGENT } from "~/server/http/publicHttp";

/**
 * The hardened fetch handed to the SDK. Its SSRF, protocol, and size guards
 * run once per call rather than per redirect hop, so following a redirect
 * would carry the request to an unchecked destination. Nothing may be
 * followed implicitly, whatever mode the caller asked for.
 */

const { createHardenedFetch } =
  await import("~/server/auth/atproto/hardened-fetch");

function stubFetch() {
  return vi.fn((input: string | Request | URL, init?: RequestInit) => {
    void input;
    void init;
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
}

function receivedRequest(stub: ReturnType<typeof stubFetch>): Request {
  const input = stub.mock.calls[0]![0];
  if (!(input instanceof Request)) throw new Error("expected a Request");
  return input;
}

describe("createHardenedFetch", () => {
  it("downgrades an explicit follow to error", async () => {
    const stub = stubFetch();
    const fetch = createHardenedFetch(stub);

    await fetch("https://pds.example/xrpc/foo", { redirect: "follow" });

    expect(receivedRequest(stub).redirect).toBe("error");
  });

  it("downgrades a Request whose mode defaulted to follow", async () => {
    const stub = stubFetch();
    const fetch = createHardenedFetch(stub);

    // What the SDK's DPoP wrapper hands over: a Request, no init.
    await fetch(new Request("https://pds.example/xrpc/foo"));

    expect(receivedRequest(stub).redirect).toBe("error");
  });

  it("preserves manual, which the SDK's metadata resolvers rely on", async () => {
    const stub = stubFetch();
    const fetch = createHardenedFetch(stub);

    await fetch(
      new Request("https://pds.example/.well-known/x", {
        redirect: "manual",
      }),
    );

    expect(receivedRequest(stub).redirect).toBe("manual");
  });

  it("carries the request through unchanged otherwise", async () => {
    const stub = stubFetch();
    const fetch = createHardenedFetch(stub);

    await fetch(
      new Request("https://pds.example/xrpc/com.atproto.server.getSession", {
        method: "POST",
        headers: { DPoP: "proof-value" },
        redirect: "error",
      }),
    );

    const request = receivedRequest(stub);
    expect(request.method).toBe("POST");
    expect(request.headers.get("DPoP")).toBe("proof-value");
    expect(request.headers.get("User-Agent")).toBe(SERIAL_USER_AGENT);
    expect(request.url).toBe(
      "https://pds.example/xrpc/com.atproto.server.getSession",
    );
  });

  it("blocks non-http protocols", async () => {
    const stub = stubFetch();
    const fetch = createHardenedFetch(stub);

    await expect(fetch("file:///etc/passwd")).rejects.toThrow();
    expect(stub).not.toHaveBeenCalled();
  });

  it("names Serial as the User-Agent, keeping the caller's headers", async () => {
    const stub = stubFetch();
    const fetch = createHardenedFetch(stub);

    await fetch("https://pds.example/xrpc/foo", {
      headers: { Accept: "application/json", "User-Agent": "other" },
    });

    const { headers } = receivedRequest(stub);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("User-Agent")).toBe(SERIAL_USER_AGENT);
  });

  it("sends discovery-side work nothing more for a service host that answered 429", async () => {
    const stub = vi.fn((input: string | Request | URL) =>
      Promise.resolve(
        new Response("{}", {
          status: new URL(
            String(input instanceof Request ? input.url : input),
          ).hostname.startsWith("limited")
            ? 429
            : 200,
          headers: { "Retry-After": "30" },
        }),
      ),
    );
    const fetch = createHardenedFetch(stub);

    await withDiscoveryPacing(async () => {
      expect((await fetch("https://limited.pds.example/xrpc/a")).status).toBe(
        429,
      );
      await expect(
        fetch("https://limited.pds.example/xrpc/b"),
      ).rejects.toBeInstanceOf(DiscoveryPausedError);
      expect((await fetch("https://other.pds.example/xrpc/c")).status).toBe(
        200,
      );
    });
    // Other work is not paced.
    expect((await fetch("https://limited.pds.example/xrpc/d")).status).toBe(
      429,
    );
    expect(
      stub.mock.calls.map(
        ([input]) =>
          new URL(String(input instanceof Request ? input.url : input))
            .pathname,
      ),
    ).toEqual(["/xrpc/a", "/xrpc/c", "/xrpc/d"]);
  });
});

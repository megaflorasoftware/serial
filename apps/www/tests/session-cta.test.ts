import { describe, expect, it } from "vitest";
import {
  applySignedInLabel,
  checkSession,
  isSignedIn,
  sessionEndpointUrl,
  SIGNED_IN_LABEL,
} from "../src/lib/session-cta";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sessionEndpointUrl", () => {
  it("builds the Better Auth session endpoint from the app origin", () => {
    expect(sessionEndpointUrl("https://app.serial.tube")).toBe(
      "https://app.serial.tube/api/auth/get-session",
    );
  });

  it("ignores a path on the app url", () => {
    expect(sessionEndpointUrl("https://app.serial.tube/some/path")).toBe(
      "https://app.serial.tube/api/auth/get-session",
    );
  });
});

describe("isSignedIn", () => {
  it("is true for a 200 with a session object", async () => {
    const response = jsonResponse({
      session: { id: "s1" },
      user: { id: "u1" },
    });
    await expect(isSignedIn(response)).resolves.toBe(true);
  });

  it("is false for a 200 with a null body", async () => {
    await expect(isSignedIn(jsonResponse(null))).resolves.toBe(false);
  });

  it("is false for a 200 with a null session", async () => {
    await expect(
      isSignedIn(jsonResponse({ session: null, user: null })),
    ).resolves.toBe(false);
  });

  it("is false for a non-200 status", async () => {
    await expect(
      isSignedIn(jsonResponse({ session: { id: "s1" } }, 401)),
    ).resolves.toBe(false);
  });

  it("is false when the body is not json", async () => {
    await expect(
      isSignedIn(new Response("<html>", { status: 200 })),
    ).resolves.toBe(false);
  });
});

describe("checkSession", () => {
  it("sends a credentialed request to the session endpoint", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push([String(input), init]);
      return jsonResponse({ session: { id: "s1" }, user: { id: "u1" } });
    };
    await expect(
      checkSession("https://app.serial.tube", fetchImpl),
    ).resolves.toBe(true);
    expect(calls).toEqual([
      [
        "https://app.serial.tube/api/auth/get-session",
        { credentials: "include" },
      ],
    ]);
  });

  it("is false when fetch throws (network failure or CORS refusal)", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(
      checkSession("https://app.serial.tube", fetchImpl),
    ).resolves.toBe(false);
  });
});

describe("applySignedInLabel", () => {
  it("relabels every element it is given", () => {
    const elements = [document.createElement("a"), document.createElement("a")];
    for (const element of elements) element.textContent = "Get Started";
    applySignedInLabel(elements);
    expect(elements.map((element) => element.textContent)).toEqual([
      SIGNED_IN_LABEL,
      SIGNED_IN_LABEL,
    ]);
  });
});

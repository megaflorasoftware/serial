import { OAuthCallbackError } from "@atproto/oauth-client-node";
import { describe, expect, it } from "vitest";
import { isConsentDenied } from "~/server/auth/atproto/consent";

/**
 * The upgrade callback tells a refusal apart from every other failure by
 * the SDK's own callback error carrying app state, never by the raw query
 * params, so a forged or replayed request cannot dress an error up as a
 * decline.
 */
describe("isConsentDenied", () => {
  const APP_STATE = JSON.stringify({ expectedDid: "did:plc:x" });

  it("recognises the SDK's access_denied callback error for a live attempt", () => {
    const err = new OAuthCallbackError(
      new URLSearchParams("state=abc&error=access_denied"),
      undefined,
      APP_STATE,
    );
    expect(isConsentDenied(err)).toBe(true);
  });

  it("treats other SDK callback errors as failures", () => {
    const err = new OAuthCallbackError(
      new URLSearchParams("state=abc&error=invalid_scope"),
      undefined,
      APP_STATE,
    );
    expect(isConsentDenied(err)).toBe(false);
  });

  it("treats a replayed or unknown attempt as a failure even with a denial param", () => {
    // The SDK throws this before it has matched a stored attempt, so no
    // app state rides on the error.
    const err = new OAuthCallbackError(
      new URLSearchParams("state=used&error=access_denied"),
      'Unknown authorization session "used"',
    );
    expect(isConsentDenied(err)).toBe(false);
  });

  it("ignores a denial param on an error the SDK did not raise", () => {
    expect(
      isConsentDenied(new Error('Unknown authorization session "abc"')),
    ).toBe(false);
  });
});

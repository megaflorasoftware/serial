import { OAuthCallbackError } from "@atproto/oauth-client-node";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/server/auth/atproto/config", () => ({
  ATPROTO_PROVIDER_ID: "atproto",
  ATPROTO_ROUTE_PREFIX: "/atproto/",
  ATPROTO_ROUTES: {},
  getAtprotoLinkRedirectUri: () => "https://serial.test/link",
  getAtprotoUpgradeRedirectUri: () => "https://serial.test/upgrade",
  placeholderEmailForDid: () => "x@atproto.invalid",
  validateAtprotoConfigAtStartup: () => {},
}));
vi.mock("~/server/auth/atproto/client", () => ({ getAtprotoClient: vi.fn() }));
vi.mock("~/server/auth/atproto/service", () => ({}));
vi.mock("~/server/auth/atproto/typeahead", () => ({}));
vi.mock("~/server/auth/policy", () => ({}));

const { isConsentDenied } = await import("~/server/auth/atproto/plugin");

/**
 * The upgrade callback tells a refusal apart from every other failure by
 * the SDK's own callback error, never by the raw query params, so a forged
 * or replayed request cannot dress an error up as a decline.
 */
describe("isConsentDenied", () => {
  it("recognises the SDK's access_denied callback error", () => {
    const err = new OAuthCallbackError(
      new URLSearchParams("state=abc&error=access_denied"),
    );
    expect(isConsentDenied(err)).toBe(true);
  });

  it("treats other SDK callback errors as failures", () => {
    const err = new OAuthCallbackError(
      new URLSearchParams("state=abc&error=invalid_scope"),
    );
    expect(isConsentDenied(err)).toBe(false);
  });

  it("ignores a denial param on an error the SDK did not raise", () => {
    expect(
      isConsentDenied(new Error('Unknown authorization session "abc"')),
    ).toBe(false);
  });
});

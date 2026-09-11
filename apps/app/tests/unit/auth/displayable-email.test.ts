import { describe, expect, it } from "vitest";
import {
  ATPROTO_PLACEHOLDER_EMAIL_DOMAIN,
  getDisplayableEmail,
} from "~/lib/auth/atproto";

describe("getDisplayableEmail", () => {
  it("returns a real address unchanged", () => {
    expect(getDisplayableEmail("reader@example.com")).toBe(
      "reader@example.com",
    );
  });

  it("hides the DID placeholder address", () => {
    expect(
      getDisplayableEmail(
        `did-plc-abc.hmac@${ATPROTO_PLACEHOLDER_EMAIL_DOMAIN}`,
      ),
    ).toBeUndefined();
  });

  it("treats a missing or empty address as no email", () => {
    expect(getDisplayableEmail(undefined)).toBeUndefined();
    expect(getDisplayableEmail(null)).toBeUndefined();
    expect(getDisplayableEmail("")).toBeUndefined();
  });
});

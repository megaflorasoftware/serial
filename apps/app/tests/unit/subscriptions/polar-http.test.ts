import { describe, expect, it } from "vitest";
import type { Fetcher } from "@polar-sh/sdk/lib/http.js";
import {
  createPolarHttpClient,
  POLAR_VERSION_HEADER,
  resolvePolarApiVersion,
} from "~/server/subscriptions/polar-http";

/**
 * Deliberately literal. An SDK bump that moves the generated spec version
 * must update this expectation so the migration is acknowledged in review.
 */
const EXPECTED_POLAR_API_VERSION = "2026-04";

function createCapturingFetcher() {
  const sent: Request[] = [];
  const fetcher: Fetcher = (input) => {
    sent.push(input as Request);
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  return { fetcher, sent };
}

describe("resolvePolarApiVersion", () => {
  it("accepts a date-based version", () => {
    expect(resolvePolarApiVersion("2026-10")).toBe("2026-10");
  });

  it("rejects a pre-versioning SDK spec version", () => {
    expect(() => resolvePolarApiVersion("0.1.0")).toThrow(/YYYY-MM/);
  });

  it("rejects an out-of-range month", () => {
    expect(() => resolvePolarApiVersion("2026-13")).toThrow(/YYYY-MM/);
  });
});

describe("createPolarHttpClient", () => {
  it("pins every request to the Polar API version", async () => {
    const { fetcher, sent } = createCapturingFetcher();
    const client = createPolarHttpClient({ fetcher });

    await client.request(new Request("https://api.polar.sh/v1/subscriptions"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get(POLAR_VERSION_HEADER)).toBe(
      EXPECTED_POLAR_API_VERSION,
    );
  });

  it("keeps the caller's other headers intact", async () => {
    const { fetcher, sent } = createCapturingFetcher();
    const client = createPolarHttpClient({ fetcher });

    await client.request(
      new Request("https://api.polar.sh/v1/products", {
        headers: { Authorization: "Bearer token" },
      }),
    );

    expect(sent[0]?.headers.get("Authorization")).toBe("Bearer token");
    expect(sent[0]?.headers.get(POLAR_VERSION_HEADER)).toBe(
      EXPECTED_POLAR_API_VERSION,
    );
  });
});

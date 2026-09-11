import { describe, expect, it } from "vitest";
import type { Fetcher } from "@polar-sh/sdk/lib/http.js";
import {
  createPolarHttpClient,
  POLAR_API_VERSION,
  POLAR_VERSION_HEADER,
} from "~/server/subscriptions/polar-http";

function createCapturingFetcher() {
  const sent: Request[] = [];
  const fetcher: Fetcher = (input) => {
    sent.push(input as Request);
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  return { fetcher, sent };
}

describe("createPolarHttpClient", () => {
  it("pins every request to the Polar API version", async () => {
    const { fetcher, sent } = createCapturingFetcher();
    const client = createPolarHttpClient({ fetcher });

    await client.request(new Request("https://api.polar.sh/v1/subscriptions"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get(POLAR_VERSION_HEADER)).toBe(POLAR_API_VERSION);
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
    expect(sent[0]?.headers.get(POLAR_VERSION_HEADER)).toBe(POLAR_API_VERSION);
  });
});

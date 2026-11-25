import { beforeEach, expect, it, vi } from "vitest";
import {
  resolvePublicPds,
  withIdentityCache,
} from "~/server/auth/atproto/did-resolver";

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@atproto-labs/did-resolver", () => ({
  createDidResolver: () => ({ resolve: mocks.resolve }),
}));
vi.mock("~/server/auth/atproto/hardened-fetch", () => ({
  ALLOW_INSECURE_PDS: false,
  createHardenedFetch: () => vi.fn(),
}));

const document = (did: string) => ({
  id: did,
  service: [
    {
      id: "#atproto_pds",
      type: "AtprotoPersonalDataServer",
      serviceEndpoint: `https://${did.slice(8)}.example`,
    },
  ],
});
const alice = "did:plc:alice";
const bob = "did:plc:bob";

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.resolve.mockImplementation((did: string) =>
    Promise.resolve(document(did)),
  );
});

it("looks a DID up afresh outside a run", async () => {
  await resolvePublicPds(alice);
  await resolvePublicPds(alice);
  expect(mocks.resolve).toHaveBeenCalledTimes(2);
  expect(mocks.resolve).toHaveBeenCalledWith(
    alice,
    expect.objectContaining({ noCache: true }),
  );
});

it("looks each DID up once within a run, nested runs included", async () => {
  const pds = await withIdentityCache(async () => [
    await resolvePublicPds(alice),
    await resolvePublicPds(bob),
    await withIdentityCache(() => resolvePublicPds(alice)),
  ]);
  expect(pds).toEqual([
    "https://alice.example",
    "https://bob.example",
    "https://alice.example",
  ]);
  expect(mocks.resolve).toHaveBeenCalledTimes(2);
  // The next run reads the document afresh.
  await withIdentityCache(() => resolvePublicPds(alice));
  expect(mocks.resolve).toHaveBeenCalledTimes(3);
});

it("never shares a lookup its caller may abort", async () => {
  await withIdentityCache(async () => {
    const stop = new AbortController();
    await resolvePublicPds(alice, { signal: stop.signal });
    await resolvePublicPds(alice);
    await resolvePublicPds(alice);
  });
  expect(mocks.resolve).toHaveBeenCalledTimes(2);
  expect(mocks.resolve.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
});

it("does not keep a lookup that failed", async () => {
  mocks.resolve.mockRejectedValueOnce(new Error("PLC unavailable"));
  await withIdentityCache(async () => {
    await expect(resolvePublicPds(alice)).rejects.toThrow("PLC unavailable");
    expect(await resolvePublicPds(alice)).toBe("https://alice.example");
  });
  expect(mocks.resolve).toHaveBeenCalledTimes(2);
});

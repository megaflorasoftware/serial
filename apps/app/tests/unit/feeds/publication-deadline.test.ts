import { beforeEach, expect, it, vi } from "vitest";
import { searchPublications } from "~/server/feeds/publications";
import { getAtprotoIdentityResolver } from "~/server/auth/atproto/identity";
import { searchAtprotoActorsTypeahead } from "~/server/auth/atproto/typeahead";

vi.mock("~/server/auth/atproto/identity", () => ({
  getAtprotoIdentityResolver: vi.fn(),
}));
vi.mock("~/server/auth/atproto/typeahead", () => ({
  searchAtprotoActorsTypeahead: vi.fn(),
}));
vi.mock("~/server/auth/atproto/hardened-fetch", () => ({
  createHardenedFetch: () => vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
it("aborts active identities and never starts queued actors after the shared deadline", async () => {
  const controller = new AbortController();
  vi.mocked(searchAtprotoActorsTypeahead).mockResolvedValue(
    Array.from({ length: 5 }, (_, index) => ({
      did: `did:plc:actor${index}`,
      handle: `actor${index}.test`,
    })),
  );
  const resolve = vi.fn(
    (_identifier, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  vi.mocked(getAtprotoIdentityResolver).mockReturnValue({
    resolve,
  } as unknown as ReturnType<typeof getAtprotoIdentityResolver>);
  const result = searchPublications("actor", controller.signal);
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
  controller.abort();
  expect(await result).toEqual([]);
  expect(resolve).toHaveBeenCalledTimes(2);
});

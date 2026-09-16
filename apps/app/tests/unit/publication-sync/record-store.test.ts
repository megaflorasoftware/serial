import { describe, expect, it, vi } from "vitest";
import { buildSubscriptionRecordKey } from "@serial/standard-site";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { createPublicSubscriptionStore } from "~/server/publication-sync/record-store";

const did = "did:plc:abcdefghijklmnopqrstuvwx";
const publication = `at://${did}/site.standard.publication/one`;
const uri = (key: string) =>
  `at://${did}/site.standard.graph.subscription/${key}`;
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const fetchHandler = vi.fn<OAuthSession["fetchHandler"]>();
  const restore = vi.fn(
    async () => ({ fetchHandler }) as unknown as OAuthSession,
  );
  const authorizeWrite = vi.fn(async () => {});
  const store = createPublicSubscriptionStore({
    did,
    fetch,
    restore,
    authorizeWrite,
    resolvePds: async () => "https://pds.example.com",
  });
  return { store, fetch, fetchHandler, restore, authorizeWrite };
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
describe("public subscription record store", () => {
  it("pages public reads without requiring OAuth or write permission", async () => {
    const f = fixture();
    f.fetch
      .mockResolvedValueOnce(
        json({
          records: [{ uri: uri("a"), cid: "a", value: { publication } }],
          cursor: "next",
        }),
      )
      .mockResolvedValueOnce(
        json({
          records: [{ uri: uri("b"), cid: "b", value: { publication } }],
        }),
      );
    expect(await f.store.list()).toEqual({
      records: [
        { uri: uri("a"), cid: "a", publicationUri: publication },
        { uri: uri("b"), cid: "b", publicationUri: publication },
      ],
      invalidRecordUris: [],
    });
    expect(
      new URL(String(f.fetch.mock.calls[1]?.[0])).searchParams.get("cursor"),
    ).toBe("next");
    expect(f.restore).not.toHaveBeenCalled();
    expect(f.authorizeWrite).not.toHaveBeenCalled();
  });
  it("isolates invalid record values while identifying the record whose deletion must not be inferred", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(
      json({
        records: [
          { uri: uri("a"), cid: "a", value: { publication } },
          { uri: uri("bad"), value: {} },
        ],
      }),
    );
    expect(await f.store.list()).toMatchObject({
      records: [{ uri: uri("a") }],
      invalidRecordUris: [uri("bad")],
    });
  });
  it("rejects a repeated cursor or record instead of treating a truncated snapshot as complete", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () =>
      json({ records: [], cursor: "repeat" }),
    );
    await expect(f.store.list()).rejects.toThrow("bounds");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("writes the shared deterministic key without overwriting a concurrent record", async () => {
    const f = fixture();
    const rkey = await buildSubscriptionRecordKey(publication);
    f.fetchHandler.mockResolvedValue(json({ uri: uri(rkey), cid: "new" }));
    expect(await f.store.create(publication)).toMatchObject({
      uri: uri(rkey),
      publicationUri: publication,
    });
    expect(
      JSON.parse(String(f.fetchHandler.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ rkey, swapRecord: null, record: { publication } });
    expect(f.authorizeWrite).toHaveBeenCalledTimes(2);
  });
  it("checks the grant again after session restoration and never sends the write if it narrowed", async () => {
    const f = fixture();
    f.authorizeWrite
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("grant narrowed"));
    await expect(f.store.create(publication)).rejects.toThrow("grant narrowed");
    expect(f.fetchHandler).not.toHaveBeenCalled();
  });
  it("deletes with the observed CID and rejects records outside the connection", async () => {
    const f = fixture();
    f.fetchHandler.mockResolvedValue(new Response(null, { status: 200 }));
    await f.store.remove({
      uri: uri("a"),
      cid: "seen",
      publicationUri: publication,
    });
    expect(
      JSON.parse(String(f.fetchHandler.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ rkey: "a", swapRecord: "seen" });
    await expect(
      f.store.remove({
        uri: uri("a").replace(did, "did:plc:other"),
        cid: "seen",
        publicationUri: publication,
      }),
    ).rejects.toThrow("URI mismatch");
    expect(f.fetchHandler).toHaveBeenCalledTimes(1);
  });
});

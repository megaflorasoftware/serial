import { describe, expect, it, vi } from "vitest";
import {
  createPublicationClient,
  MissingPublicationRecordError,
} from "~/server/rss/atprotoClient";

const uri = "at://did:plc:alice/site.standard.publication/site";
function client(response: () => Response) {
  const fetch = vi.fn(async () => response());
  const resolvePds = vi.fn(async () => "https://pds.example.com");
  return {
    remote: createPublicationClient({ fetch, resolvePds }),
    fetch,
    resolvePds,
  };
}

describe("publication transport", () => {
  it("caches simultaneous record and identity reads within a refresh", async () => {
    const { remote, fetch, resolvePds } = client(() =>
      Response.json({
        uri,
        cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        value: { name: "Site", url: "https://example.com" },
      }),
    );
    const results = await Promise.all([
      remote.resolveRecord(uri),
      remote.resolveRecord(uri),
    ]);
    expect(results[0]).toEqual({ title: "Site", url: "https://example.com" });
    expect(results[1]).toEqual(results[0]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolvePds).not.toHaveBeenCalled();
  });
  it.each([404, 400])(
    "recognizes missing records with HTTP %s",
    async (status) => {
      const { remote } = client(() =>
        Response.json({ error: "RecordNotFound" }, { status }),
      );
      await expect(remote.getRecord(uri)).rejects.toBeInstanceOf(
        MissingPublicationRecordError,
      );
      expect(await remote.resolveRecord(uri)).toBeNull();
    },
  );
  it("propagates transient failures for retry", async () => {
    const { remote } = client(() => new Response(null, { status: 503 }));
    await expect(remote.resolveRecord(uri)).rejects.toThrow("503");
  });
  it("rejects a response for a different record", async () => {
    const { remote } = client(() =>
      Response.json({
        uri: `${uri}-other`,
        cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        value: {},
      }),
    );
    await expect(remote.getRecord(uri)).rejects.toThrow("Record URI mismatch");
  });
  it("does not render an unsafe publication URL", async () => {
    const { remote } = client(() =>
      Response.json({
        uri,
        cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        value: { name: "Site", url: "javascript:alert(1)" },
      }),
    );
    expect(await remote.resolveRecord(uri)).toMatchObject({
      title: "Site",
      url: `https://pdsls.dev/${uri}`,
    });
  });
});

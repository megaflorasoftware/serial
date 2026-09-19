import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { recordPreview } from "@serial/standard-site";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import {
  createPublicationClient,
  MissingPublicationRecordError,
} from "~/server/rss/atprotoClient";
import {
  IMPORT_REUSE_MS,
  refreshReferenceSnapshots,
} from "~/server/jetstream/reference-snapshots";
import { atprotoReferenceSnapshots } from "~/server/db/schema";

const uri = "at://did:plc:alice/site.standard.publication/site";
const cid = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-09-19T12:00:00Z");
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
  let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
  beforeAll(async () => {
    fixture = await createBookmarkTestDatabase();
  });
  afterAll(() => fixture.cleanup());
  // Snapshots are shared across documents, so each case starts with none.
  beforeEach(() => fixture.database.delete(atprotoReferenceSnapshots));
  /** The outcome a reference snapshot records for one lookup through the client. */
  async function snapshot(remote: ReturnType<typeof client>["remote"]) {
    const snapshots = await refreshReferenceSnapshots(
      fixture.database,
      [uri],
      (target) => remote.getRecord(target),
      { now: NOW, reuseMs: IMPORT_REUSE_MS },
    );
    return snapshots.get(uri);
  }

  it("caches simultaneous record and identity reads within a refresh", async () => {
    const { remote, fetch, resolvePds } = client(() =>
      Response.json({
        uri,
        cid,
        value: { name: "Site", url: "https://example.com" },
      }),
    );
    const results = await Promise.all([
      remote.getRecord(uri),
      remote.getRecord(uri),
    ]);
    expect(recordPreview(uri, () => results[0])).toEqual({
      title: "Site",
      url: "https://example.com",
    });
    expect(results[1]).toBe(results[0]);
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
      expect(await snapshot(remote)).toMatchObject({
        outcome: "missing",
        cid: null,
        record: null,
      });
    },
  );
  it("propagates transient failures for retry", async () => {
    const { remote } = client(() => new Response(null, { status: 503 }));
    await expect(remote.getRecord(uri)).rejects.toThrow("503");
    expect(await snapshot(remote)).toMatchObject({ outcome: "unavailable" });
  });
  it("treats an unreadable record body as unsupported", async () => {
    const { remote } = client(() => new Response("{"));
    expect(await snapshot(remote)).toMatchObject({ outcome: "unsupported" });
  });
  it("rejects a response for a different record", async () => {
    const { remote } = client(() =>
      Response.json({ uri: `${uri}-other`, cid, value: {} }),
    );
    await expect(remote.getRecord(uri)).rejects.toThrow("Record URI mismatch");
  });
  it("does not render an unsafe publication URL", async () => {
    const { remote } = client(() =>
      Response.json({
        uri,
        cid,
        value: { name: "Site", url: "javascript:alert(1)" },
      }),
    );
    const record = await remote.getRecord(uri);
    expect(recordPreview(uri, () => record)).toMatchObject({
      title: "Site",
      url: `https://pdsls.dev/${uri}`,
    });
  });
});

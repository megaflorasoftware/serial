import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  deriveReaderDocument,
  recordPreview,
  REFERENCE_IMPORT_REUSE_MS,
} from "@serial/standard-site";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import {
  createPublicationClient,
  MissingPublicationRecordError,
} from "~/server/rss/atprotoClient";
import {
  referenceReaders,
  refreshReferenceSnapshots,
  resolveSourceReferences,
} from "~/server/jetstream/reference-snapshots";
import { atprotoReferenceSnapshots } from "~/server/db/schema";
import { UnsupportedDidError } from "~/server/auth/atproto/did-resolver";

const uri = "at://did:plc:alice/site.standard.publication/site";
const cid = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2026-09-19T12:00:00Z");
function client(response: () => Response) {
  const fetch = vi.fn(async () => response());
  const resolvePds = vi.fn(async () => "https://pds.example.com");
  return {
    remote: createPublicationClient({
      fetch,
      resolvePds,
      resolveDidDocument: vi.fn(),
    }),
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
      referenceReaders(remote, 5_000),
      { now: NOW, reuseMs: REFERENCE_IMPORT_REUSE_MS },
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
  it("retries an unsupported verdict recorded before its collection was supported", async () => {
    const post = "at://did:plc:alice/app.bsky.feed.post/p";
    await fixture.database.insert(atprotoReferenceSnapshots).values({
      uri: post,
      cid: null,
      outcome: "unsupported",
      record: null,
      resolvedAt: new Date("2026-09-20T00:00:00Z"),
      readAt: null,
    });
    const { remote } = client(() =>
      Response.json({
        uri: post,
        cid,
        value: {
          $type: "app.bsky.feed.post",
          text: "hi",
          createdAt: "2026-07-15T00:00:00Z",
        },
      }),
    );
    const snapshots = await refreshReferenceSnapshots(
      fixture.database,
      [post],
      referenceReaders(remote, 5_000),
      { now: NOW, reuseMs: REFERENCE_IMPORT_REUSE_MS },
    );
    expect(snapshots.get(post)?.outcome).toBe("resolved");
  });
  it("snapshots DID documents under their DID and always refreshes them", async () => {
    const did = "did:plc:alice";
    let handle = "alice.example";
    const resolveDidDocument = vi.fn(async () => ({
      id: did,
      alsoKnownAs: [`at://${handle}`],
    }));
    const remote = createPublicationClient({
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
      resolvePds: vi.fn(async () => "https://pds.example.com"),
      resolveDidDocument,
    });
    const first = await refreshReferenceSnapshots(
      fixture.database,
      [did],
      referenceReaders(remote, 5_000),
      { now: NOW, reuseMs: 0 },
    );
    expect(first.get(did)).toMatchObject({
      outcome: "resolved",
      cid: null,
      record: expect.stringContaining("alice.example"),
    });
    expect(resolveDidDocument).toHaveBeenCalledWith(
      did,
      expect.objectContaining({ deadline: expect.any(Number) }),
    );
    handle = "alice.moved";
    const second = await refreshReferenceSnapshots(
      fixture.database,
      [did],
      referenceReaders(
        createPublicationClient({
          fetch: vi.fn(async () => new Response(null, { status: 500 })),
          resolvePds: vi.fn(async () => "https://pds.example.com"),
          resolveDidDocument: vi.fn(async () => ({
            id: did,
            alsoKnownAs: [`at://${handle}`],
          })),
        }),
        5_000,
      ),
      { now: new Date(NOW.getTime() + 1), reuseMs: 0 },
    );
    expect(second.get(did)?.record).toContain("alice.moved");
  });
  it.each([
    [Object.assign(new Error("gone"), { status: 404 }), "missing"],
    [new Error("timeout"), "unavailable"],
    [new UnsupportedDidError(), "unsupported"],
  ])("maps a DID document failure %o to %s", async (error, outcome) => {
    const did = "did:plc:gone";
    const remote = createPublicationClient({
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
      resolvePds: vi.fn(async () => "https://pds.example.com"),
      resolveDidDocument: vi.fn(async () => {
        throw error;
      }),
    });
    const snapshots = await refreshReferenceSnapshots(
      fixture.database,
      [did],
      referenceReaders(remote, 5_000),
      { now: NOW, reuseMs: 0 },
    );
    expect(snapshots.get(did)).toMatchObject({ outcome, record: null });
  });
  it("resolves social posts and walks to their authors, handles and quotes", async () => {
    const author = "did:plc:author";
    const post = `at://${author}/app.bsky.feed.post/p`;
    const quoted = `at://did:plc:quoter/app.bsky.feed.post/q`;
    const values: Record<string, unknown> = {
      [post]: {
        $type: "app.bsky.feed.post",
        text: "hi",
        createdAt: "2026-07-15T22:08:33.054Z",
        embed: {
          $type: "app.bsky.embed.record",
          record: { uri: quoted, cid },
        },
      },
      [quoted]: {
        $type: "app.bsky.feed.post",
        text: "quoted",
        createdAt: "2026-07-15T22:08:33.054Z",
      },
      [`at://${author}/app.bsky.actor.profile/self`]: {
        $type: "app.bsky.actor.profile",
        displayName: "Author",
      },
      [`at://did:plc:quoter/app.bsky.actor.profile/self`]: {
        $type: "app.bsky.actor.profile",
        displayName: "Quoter",
      },
    };
    const remote = createPublicationClient({
      fetch: vi.fn(async (input: string | URL | Request) => {
        const target = new URL(input instanceof Request ? input.url : input);
        const parameters = target.searchParams;
        const record = `at://${parameters.get("repo")}/${parameters.get("collection")}/${parameters.get("rkey")}`;
        return record in values
          ? Response.json({ uri: record, cid, value: values[record] })
          : Response.json({ error: "RecordNotFound" }, { status: 404 });
      }),
      resolvePds: vi.fn(async () => "https://pds.example.com"),
      resolveDidDocument: vi.fn(async (did: string) => ({
        id: did,
        alsoKnownAs: [`at://${did.slice("did:plc:".length)}.example`],
      })),
    });
    const source = {
      uri: `at://${author}/site.standard.document/d`,
      cid,
      record: JSON.stringify({
        $type: "site.standard.document",
        site: "https://example.com",
        title: "Doc",
        publishedAt: "2026-07-15T00:00:00Z",
        content: {
          $type: "pub.leaflet.content",
          pages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: {
                    $type: "pub.leaflet.blocks.bskyPost",
                    postRef: { uri: post, cid },
                  },
                },
              ],
            },
          ],
        },
      }),
      blobs: [],
    };
    const references = await resolveSourceReferences(
      fixture.database,
      source,
      author,
      referenceReaders(remote, 5_000),
      { now: NOW, reuseMs: REFERENCE_IMPORT_REUSE_MS },
    );
    expect(
      references.map((reference) => [reference.uri, reference.outcome]),
    ).toEqual([
      [post, "resolved"],
      [`at://${author}/app.bsky.actor.profile/self`, "resolved"],
      [author, "resolved"],
      [quoted, "resolved"],
      [`at://did:plc:quoter/app.bsky.actor.profile/self`, "resolved"],
      ["did:plc:quoter", "resolved"],
    ]);
    const document = deriveReaderDocument(
      { form: "source", source, references, revision: cid },
      author,
    );
    const [block] = document?.blocks ?? [];
    expect(block).toMatchObject({
      kind: "socialPost",
      post: {
        author: { name: "Author", handle: "author.example" },
        quote: {
          post: { author: { name: "Quoter", handle: "quoter.example" } },
        },
      },
    });
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

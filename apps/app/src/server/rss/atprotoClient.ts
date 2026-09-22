import { z } from "zod";
import { parseLosslessJson } from "@serial/standard-site";
import { createHardenedFetch } from "../auth/atproto/hardened-fetch";
import {
  resolvePublicDidDocument,
  resolvePublicPds,
} from "../auth/atproto/did-resolver";

import { createPublicRecordReader } from "../auth/atproto/public-record";
import type { PublicRecordRequest } from "@serial/standard-site";
import type { PublicRecordOptions } from "../auth/atproto/public-record";
import type { HardenedFetch } from "../auth/atproto/hardened-fetch";

export { MissingPublicRecordError as MissingPublicationRecordError } from "@serial/standard-site";

const pageSchema = z.object({
  records: z.array(z.unknown()).max(100),
  cursor: z.string().max(4096).optional(),
});
export type PublicationClient = ReturnType<typeof createPublicationClient>;

/** One refresh caches identity and record reads; it never follows embedded content. */
export function createPublicationClient(
  dependencies: {
    fetch: HardenedFetch;
    resolvePds: (did: string) => Promise<string>;
    /** Defaults to the public resolver; tests that never read handles omit it. */
    resolveDidDocument?: (did: string) => Promise<unknown>;
  } = {
    fetch: createHardenedFetch(undefined, {
      responseMaxSize: 10 * 1024 * 1024,
    }),
    resolvePds: resolvePublicPds,
  },
) {
  // Looked up per call so a test that mocks the resolver module without this
  // export still builds a client; only DID document reads then fail.
  const resolveDidDocument = (did: string) =>
    (dependencies.resolveDidDocument ?? resolvePublicDidDocument)(did);
  const pds = new Map<string, Promise<string>>();
  const records = new Map<string, Promise<unknown>>();
  const didDocuments = new Map<string, Promise<unknown>>();
  const resolvePds = (did: string) => {
    if (!pds.has(did)) pds.set(did, dependencies.resolvePds(did));
    return pds.get(did)!;
  };
  async function request(
    did: string,
    method: string,
    query: Record<string, string>,
    etag?: string | null,
  ) {
    const base = new URL(await resolvePds(did));
    if (
      base.username ||
      base.password ||
      !["https:", "http:"].includes(base.protocol)
    )
      throw new Error("Invalid PDS endpoint");
    const url = new URL(`/xrpc/${method}`, base);
    url.search = new URLSearchParams(query).toString();
    return dependencies.fetch(url, {
      headers: etag ? { "If-None-Match": etag } : undefined,
    });
  }
  const readRecord = createPublicRecordReader({
    fetch: dependencies.fetch,
    resolvePds,
  });
  async function getRecord(
    uri: string,
    options: PublicRecordOptions & Omit<PublicRecordRequest, "uri"> = {},
  ): Promise<unknown> {
    const { cid, record, ...budget } = options;
    if (record !== undefined) return readRecord({ uri, cid, record }, budget);
    const key = JSON.stringify([uri, cid]);
    if (!records.has(key)) records.set(key, readRecord({ uri, cid }, budget));
    return records.get(key)!;
  }
  /** The DID document itself, for the handle a profile record does not carry. */
  function getDidDocument(did: string): Promise<unknown> {
    if (!didDocuments.has(did)) didDocuments.set(did, resolveDidDocument(did));
    return didDocuments.get(did)!;
  }
  return {
    resolvePds,
    getRecord,
    getDidDocument,
    async latestRev(did: string) {
      try {
        const response = await request(
          did,
          "com.atproto.sync.getLatestCommit",
          { did },
        );
        if (!response.ok) return null;
        return z
          .object({ rev: z.string().max(256) })
          .parse(await response.json()).rev;
      } catch {
        return null;
      }
    },
    async list(did: string, cursor?: string | null, etag?: string | null) {
      const response = await request(
        did,
        "com.atproto.repo.listRecords",
        {
          repo: did,
          collection: "site.standard.document",
          reverse: "true",
          limit: "100",
          ...(cursor ? { cursor } : {}),
        },
        etag,
      );
      if (response.status === 304)
        return {
          notModified: true as const,
          records: [],
          cursor: undefined,
          etag: etag ?? null,
        };
      if (!response.ok)
        throw new Error(`Document listing failed: ${response.status}`);
      // Record values keep their digits so staging can retain them losslessly.
      return {
        ...pageSchema.parse(parseLosslessJson(await response.text())),
        notModified: false as const,
        etag: response.headers.get("etag"),
      };
    },
    async loadBlob(did: string, cid: string) {
      if (!/^[a-zA-Z0-9]{1,256}$/.test(cid))
        throw new Error("Invalid blob CID");
      const response = await request(did, "com.atproto.sync.getBlob", {
        did,
        cid,
      });
      if (!response.ok)
        throw new Error(`Blob fetch failed: ${response.status}`);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type"),
      };
    },
  };
}

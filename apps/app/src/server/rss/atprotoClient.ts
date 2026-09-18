import { z } from "zod";
import {
  buildCanonicalDocumentUrl,
  MissingPublicRecordError as MissingPublicationRecordError,
  normalizePublicationUrl,
  parseAtUri,
  parseDocumentRecord,
  parsePublicationRecord,
} from "@serial/standard-site";
import { createHardenedFetch } from "../auth/atproto/hardened-fetch";
import { resolvePublicPds } from "../auth/atproto/did-resolver";

import { createPublicRecordReader } from "../auth/atproto/public-record";
import { ATMOSPHERE_EMBEDDED_RECORDS_PER_REFRESH } from "./atmospherePolicy";
import type { PublicRecordRequest } from "@serial/standard-site";
import type { PublicRecordOptions } from "../auth/atproto/public-record";

export { MissingPublicRecordError as MissingPublicationRecordError } from "@serial/standard-site";

const pageSchema = z.object({
  records: z.array(z.unknown()).max(100),
  cursor: z.string().max(4096).optional(),
});
export type PublicationClient = ReturnType<typeof createPublicationClient>;

/** One refresh caches identity and referenced records; it never follows embedded content. */
export function createPublicationClient(
  dependencies = {
    fetch: createHardenedFetch(undefined, {
      responseMaxSize: 10 * 1024 * 1024,
    }),
    resolvePds: resolvePublicPds,
  },
) {
  const pds = new Map<string, Promise<string>>();
  const records = new Map<string, Promise<unknown>>();
  const embeddedUris = new Set<string>();
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
  return {
    resolvePds,
    getRecord,
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
      return {
        ...pageSchema.parse(await response.json()),
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
      return new Uint8Array(await response.arrayBuffer());
    },
    async resolveRecord(uri: string) {
      const parts = parseAtUri(uri);
      if (
        !parts ||
        !["site.standard.document", "site.standard.publication"].includes(
          parts.collection,
        )
      )
        return null;
      if (!embeddedUris.has(uri)) {
        if (embeddedUris.size >= ATMOSPHERE_EMBEDDED_RECORDS_PER_REFRESH)
          throw new Error(
            "Embedded record resolution deferred to the next refresh",
          );
        embeddedUris.add(uri);
      }
      try {
        const record = await getRecord(uri);
        if (parts.collection === "site.standard.publication") {
          const publication = parsePublicationRecord(record);
          const url =
            publication && normalizePublicationUrl(publication.value.url);
          return url ? { url, title: publication.value.name } : null;
        }
        const document = parseDocumentRecord(record);
        if (!document) return null;
        const owner = parsePublicationRecord(
          await getRecord(
            document.value.site.replace(
              "/pub.leaflet.publication/",
              "/site.standard.publication/",
            ),
          ),
        );
        const url =
          owner &&
          buildCanonicalDocumentUrl(owner.value.url, document.value.path);
        return url ? { url, title: document.value.title } : null;
      } catch (error) {
        if (
          error instanceof MissingPublicationRecordError ||
          error instanceof SyntaxError
        )
          return null;
        throw error;
      }
    },
  };
}

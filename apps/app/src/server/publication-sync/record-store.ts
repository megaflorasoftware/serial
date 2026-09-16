import { createHardenedFetch } from "~/server/auth/atproto/hardened-fetch";
import { resolvePublicPds } from "~/server/auth/atproto/did-resolver";
import { z } from "zod";
import {
  buildSubscriptionRecordKey,
  parseAtUri,
  parsePublicationUri,
  parseSubscriptionRecord,
  STANDARD_SITE_COLLECTIONS,
} from "@serial/standard-site";
import { createPublicationClient } from "~/server/rss/atprotoClient";
import type { restoreAtprotoSession } from "~/server/auth/atproto/service";

export type SubscriptionRecord = {
  uri: string;
  cid: string;
  publicationUri: string;
};
/** Subscription transport is independent of sync policy and persistence. */
export interface SubscriptionRecordStore {
  visibility: "public" | "private";
  latestRev(): Promise<string | null>;
  list(): Promise<{
    records: SubscriptionRecord[];
    invalidRecordUris: string[];
  }>;
  create(publicationUri: string): Promise<SubscriptionRecord>;
  remove(record: SubscriptionRecord): Promise<void>;
}
const pageSchema = z.object({
  records: z.array(z.unknown()).max(100),
  cursor: z.string().max(4096).optional(),
});
const writeSchema = z.object({ uri: z.string(), cid: z.string() });
const COLLECTION = STANDARD_SITE_COLLECTIONS.subscription;
export const MAX_SUBSCRIPTION_RECORDS = 10_000;

export function createPublicSubscriptionStore(input: {
  did: string;
  authorizeWrite: () => Promise<void>;
  restore?: typeof restoreAtprotoSession;
  latestRev?: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  resolvePds?: typeof resolvePublicPds;
}): SubscriptionRecordStore {
  const restore =
    input.restore ??
    (async (did: string) =>
      (await import("~/server/auth/atproto/service")).restoreAtprotoSession(
        did,
      ));
  const fetch = input.fetch ?? createHardenedFetch();
  let pds: Promise<string> | undefined;
  async function request(
    method: string,
    query?: Record<string, string>,
    body?: unknown,
  ) {
    let response: Response;
    if (body) {
      await input.authorizeWrite();
      const session = await restore(input.did);
      await input.authorizeWrite();
      response = await session.fetchHandler(`/xrpc/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } else {
      pds ??= (input.resolvePds ?? resolvePublicPds)(input.did);
      const url = new URL(`/xrpc/${method}`, await pds);
      url.search = new URLSearchParams(query).toString();
      response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    }
    if (!response.ok)
      throw new Error(
        `Publication subscription request failed (${response.status})`,
      );
    return response;
  }
  return {
    visibility: "public",
    latestRev:
      input.latestRev ?? (() => createPublicationClient().latestRev(input.did)),
    async list() {
      const deadline = Date.now() + 45_000;
      const records: SubscriptionRecord[] = [];
      const invalidRecordUris: string[] = [];
      const seenUris = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        if (Date.now() >= deadline)
          throw new Error("Publication subscription listing timed out");
        const response = await request("com.atproto.repo.listRecords", {
          repo: input.did,
          collection: COLLECTION,
          limit: "100",
          ...(cursor ? { cursor } : {}),
        });
        const page = pageSchema.parse(await response.json());
        for (const raw of page.records) {
          const envelope = z.object({ uri: z.string() }).parse(raw);
          const uri = parseAtUri(envelope.uri);
          if (
            !uri ||
            uri.did !== input.did ||
            uri.collection !== COLLECTION ||
            seenUris.has(envelope.uri)
          )
            throw new Error("Invalid publication subscription listing");
          seenUris.add(envelope.uri);
          const record = parseSubscriptionRecord(raw);
          if (!record || !parsePublicationUri(record.value.publication)) {
            invalidRecordUris.push(envelope.uri);
            continue;
          }
          records.push({
            uri: record.uri,
            cid: record.cid,
            publicationUri: record.value.publication,
          });
        }
        cursor = page.cursor;
        if (
          cursor &&
          (cursors.has(cursor) || seenUris.size >= MAX_SUBSCRIPTION_RECORDS)
        )
          throw new Error(
            "Publication subscription listing exceeded its bounds",
          );
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { records, invalidRecordUris };
    },
    async create(publicationUri) {
      const rkey = await buildSubscriptionRecordKey(publicationUri);
      const response = await request("com.atproto.repo.putRecord", undefined, {
        repo: input.did,
        collection: COLLECTION,
        rkey,
        swapRecord: null,
        record: {
          $type: COLLECTION,
          publication: publicationUri,
          createdAt: new Date().toISOString(),
        },
      });
      const record = writeSchema.parse(await response.json());
      if (record.uri !== `at://${input.did}/${COLLECTION}/${rkey}`)
        throw new Error("Subscription URI mismatch");
      return { ...record, publicationUri };
    },
    async remove(record) {
      const uri = parseAtUri(record.uri);
      if (!uri || uri.did !== input.did || uri.collection !== COLLECTION)
        throw new Error("Subscription URI mismatch");
      await request("com.atproto.repo.deleteRecord", undefined, {
        repo: input.did,
        collection: COLLECTION,
        rkey: uri.rkey,
        swapRecord: record.cid,
      });
    },
  };
}

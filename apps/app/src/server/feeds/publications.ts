import {
  buildBlueskyCdnImageUrl,
  MissingPublicRecordError,
  normalizePublicationUrl,
  parsePublicationRecord,
  parsePublicationUri,
  PublicRecordHttpError,
  STANDARD_SITE_COLLECTIONS,
} from "@serial/standard-site";
import { extractPdsUrl } from "@atproto/oauth-client-node";
import type { NewFeedOriginDetails } from "~/server/rss/types";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import { createPublicRecordReader } from "~/server/auth/atproto/public-record";
import { getAtprotoIdentityResolver } from "~/server/auth/atproto/identity";
import { createHardenedFetch } from "~/server/auth/atproto/hardened-fetch";
import { searchAtprotoActorsTypeahead } from "~/server/auth/atproto/typeahead";
import { HANDLE_PATTERN } from "~/server/auth/atproto/schemas";
import { workerPool } from "~/lib/workerPool";

const PUBLICATION_PAGES = 2;
const RECORDS_PER_PAGE = 20;
const CACHE_ENTRIES = 128;
const CACHE_TTL_MS = 60_000;
const cache = new Map<
  string,
  { expires: number; value: Promise<ResolvedPublication[]> }
>();
const fetch = createHardenedFetch();

export class PublicationUnavailableError extends Error {}

export type ResolvedPublication = {
  uri: string;
  did: string;
  rkey: string;
  pdsUrl?: string;
  siteUrl: string;
  name: string;
  imageUrl?: string;
  description?: string;
};

function parseResolvedPublication(
  input: unknown,
  did: string,
  pdsUrl?: string,
): ResolvedPublication | null {
  const record = parsePublicationRecord(input);
  if (!record) return null;
  const uri = parsePublicationUri(record.uri);
  const siteUrl = normalizePublicationUrl(record.value.url);
  if (!uri || uri.did !== did || !siteUrl) return null;
  return {
    uri: record.uri,
    did,
    rkey: uri.rkey,
    pdsUrl,
    siteUrl,
    name: record.value.name,
    description: record.value.description,
    imageUrl: record.value.icon
      ? (buildBlueskyCdnImageUrl(did, record.value.icon.ref.$link, "avatar") ??
        undefined)
      : undefined,
  };
}

async function publicIdentity(identifier: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const identity = await getAtprotoIdentityResolver().resolve(identifier, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  return {
    did: identity.did,
    pdsUrl: extractPdsUrl(identity.didDoc).toString(),
  };
}

async function readRecordJson(
  pdsUrl: string,
  method: string,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const url = new URL(`${pdsUrl.replace(/\/$/, "")}/xrpc/${method}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) {
    if ([400, 401, 403, 404, 410].includes(response.status))
      throw new PublicationUnavailableError("Publication is unavailable");
    throw new Error("Unable to read publication records");
  }
  return response.json();
}

export async function resolvePublication(
  uri: string,
  signal: AbortSignal = AbortSignal.timeout(12_000),
  deadline = Date.now() + 12_000,
): Promise<ResolvedPublication | null> {
  const parts = parsePublicationUri(uri);
  if (!parts) return null;
  let pdsUrl: string | undefined;
  const readRecord = createPublicRecordReader({
    fetch,
    resolvePds: async () => {
      const identity = await publicIdentity(parts.did, signal);
      if (identity.did !== parts.did)
        throw new Error("Repository DID mismatch");
      pdsUrl = identity.pdsUrl;
      return pdsUrl;
    },
  });
  const result = await readRecord({ uri }, { signal, deadline }).catch(
    (error: unknown) => {
      if (
        error instanceof MissingPublicRecordError ||
        (error instanceof PublicRecordHttpError &&
          [400, 401, 403, 404, 410].includes(error.status))
      )
        throw new PublicationUnavailableError("Publication is unavailable");
      throw error;
    },
  );
  const publication = parseResolvedPublication(result, parts.did, pdsUrl);
  return publication?.uri === uri ? publication : null;
}

async function listPublications(
  did: string,
  signal: AbortSignal,
): Promise<ResolvedPublication[]> {
  signal.throwIfAborted();
  const existing = cache.get(did);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = (async () => {
    const identity = await publicIdentity(did, signal);
    const publications: ResolvedPublication[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PUBLICATION_PAGES; page++) {
      const response = await readRecordJson(
        identity.pdsUrl,
        "com.atproto.repo.listRecords",
        {
          repo: did,
          collection: STANDARD_SITE_COLLECTIONS.publication,
          limit: String(RECORDS_PER_PAGE),
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      if (
        !response ||
        typeof response !== "object" ||
        !("records" in response) ||
        !Array.isArray(response.records)
      )
        break;
      for (const record of response.records.slice(0, RECORDS_PER_PAGE)) {
        const publication = parseResolvedPublication(
          record,
          did,
          identity.pdsUrl,
        );
        if (publication) publications.push(publication);
      }
      const next =
        "cursor" in response && typeof response.cursor === "string"
          ? response.cursor
          : undefined;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return publications;
  })();
  const publications = await value;
  if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(did, {
    expires: Date.now() + CACHE_TTL_MS,
    value: Promise.resolve(publications),
  });
  return publications;
}

export async function searchPublications(
  term: string,
  signal: AbortSignal = AbortSignal.timeout(12_000),
): Promise<ResolvedPublication[]> {
  const actors = await searchAtprotoActorsTypeahead(term, undefined, signal);
  const dids = actors.map((actor) => actor.did);
  if (dids.length === 0 && HANDLE_PATTERN.test(term)) {
    try {
      dids.push((await publicIdentity(term, signal)).did);
    } catch {
      return [];
    }
  }
  const byDid = new Map<string, ResolvedPublication[]>();
  for await (const result of workerPool(dids, 2, async (did) => {
    try {
      return { did, publications: await listPublications(did, signal) };
    } catch {
      return { did, publications: [] };
    }
  }))
    byDid.set(result.did, result.publications);
  return dids.flatMap((did) => byDid.get(did) ?? []);
}

export function publicationRow(
  publication: ResolvedPublication,
): DiscoveredFeed {
  return {
    url: publication.siteUrl,
    siteUrl: publication.siteUrl,
    title: publication.name,
    imageUrl: publication.imageUrl,
    origins: [{ kind: "atproto", locator: publication.uri }],
  };
}

export function publicationOrigin(
  publication: ResolvedPublication,
): NewFeedOriginDetails {
  return {
    kind: "atproto",
    locator: publication.uri,
    publicationDid: publication.did,
    publicationRkey: publication.rkey,
    pdsUrl: publication.pdsUrl,
    sourceName: publication.name,
    sourceImageUrl: publication.imageUrl,
    sourceDescription: publication.description,
  };
}

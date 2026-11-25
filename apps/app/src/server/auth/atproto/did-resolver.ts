import { AsyncLocalStorage } from "node:async_hooks";
import { createDidResolver } from "@atproto-labs/did-resolver";
import { ALLOW_INSECURE_PDS, createHardenedFetch } from "./hardened-fetch";
import { env } from "~/env";

/** Shared with OAuth, but public publication reads require no OAuth configuration. */
export const publicDidResolver = createDidResolver({
  fetch: createHardenedFetch(),
  allowHttp: ALLOW_INSECURE_PDS,
  ...(env.ATPROTO_PLC_DIRECTORY_URL
    ? { plcDirectoryUrl: env.ATPROTO_PLC_DIRECTORY_URL }
    : {}),
});

/** A DID method the public resolver does not handle; never worth retrying. */
export class UnsupportedDidError extends Error {
  constructor() {
    super("Unsupported repository DID");
  }
}

type DidDocument = Awaited<ReturnType<typeof publicDidResolver.resolve>>;
const runDocuments = new AsyncLocalStorage<Map<string, Promise<DidDocument>>>();

/**
 * Runs `work` with one lookup per DID: inside it, every resolution of a DID
 * shares the first one's answer. A failed lookup is not kept. A run nested in
 * another shares the outer run's lookups.
 */
export function withIdentityCache<T>(work: () => Promise<T>) {
  return runDocuments.getStore() ? work() : runDocuments.run(new Map(), work);
}

type LookupOptions = {
  deadline?: number;
  /** A caller's own bound. A lookup it may abort is its own, never shared. */
  signal?: AbortSignal;
};

/**
 * The DID document as published, for handles and service endpoints. It is
 * read afresh each time, except within one `withIdentityCache` run, where
 * lookups without a caller's signal share one answer per DID.
 */
export async function resolvePublicDidDocument(
  did: string,
  options: LookupOptions = {},
) {
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:"))
    throw new UnsupportedDidError();
  const documents = options.signal ? undefined : runDocuments.getStore();
  const known = documents?.get(did);
  if (known) return known;
  const bounds = [
    ...(options.signal ? [options.signal] : []),
    ...(options.deadline === undefined
      ? []
      : [AbortSignal.timeout(Math.max(0, options.deadline - Date.now()))]),
  ];
  const document = publicDidResolver.resolve(did as `did:${string}:${string}`, {
    noCache: true,
    signal: bounds.length ? AbortSignal.any(bounds) : undefined,
  });
  if (documents) {
    documents.set(did, document);
    document.catch(() => documents.delete(did));
  }
  return document;
}

export async function resolvePublicPds(
  did: string,
  options: LookupOptions = {},
) {
  const document = await resolvePublicDidDocument(did, options);
  const service = document.service?.find(
    (entry) =>
      (entry.id === "#atproto_pds" || entry.id === `${did}#atproto_pds`) &&
      entry.type === "AtprotoPersonalDataServer",
  );
  if (typeof service?.serviceEndpoint !== "string")
    throw new Error("Repository has no PDS");
  return service.serviceEndpoint;
}

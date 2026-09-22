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

/** The DID document as published, for handles and service endpoints. */
export async function resolvePublicDidDocument(
  did: string,
  options: { deadline?: number } = {},
) {
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:"))
    throw new UnsupportedDidError();
  const signal =
    options.deadline === undefined
      ? undefined
      : AbortSignal.timeout(Math.max(0, options.deadline - Date.now()));
  return publicDidResolver.resolve(did as `did:${string}:${string}`, {
    noCache: true,
    signal,
  });
}

export async function resolvePublicPds(did: string) {
  const document = await resolvePublicDidDocument(did);
  const service = document.service?.find(
    (entry) =>
      (entry.id === "#atproto_pds" || entry.id === `${did}#atproto_pds`) &&
      entry.type === "AtprotoPersonalDataServer",
  );
  if (typeof service?.serviceEndpoint !== "string")
    throw new Error("Repository has no PDS");
  return service.serviceEndpoint;
}

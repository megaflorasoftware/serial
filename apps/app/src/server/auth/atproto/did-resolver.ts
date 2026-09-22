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

/** The DID document as published, for handles and service endpoints. */
export async function resolvePublicDidDocument(did: string) {
  if (!did.startsWith("did:plc:") && !did.startsWith("did:web:"))
    throw new Error("Unsupported repository DID");
  return publicDidResolver.resolve(did as `did:${string}:${string}`, {
    noCache: true,
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

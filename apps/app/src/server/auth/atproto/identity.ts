import { createIdentityResolver } from "@atproto-labs/identity-resolver";
import { AtprotoHandleResolverNode } from "@atproto/oauth-client-node";
import { ALLOW_INSECURE_PDS, createHardenedFetch } from "./hardened-fetch";
import { publicDidResolver } from "./did-resolver";
import { env } from "~/env";

let resolver: ReturnType<typeof createIdentityResolver> | undefined;

/** Public identity reads use the same resolver as OAuth without requiring keys or a session. */
export function getAtprotoIdentityResolver() {
  if (!resolver) {
    const fetch = createHardenedFetch();
    resolver = createIdentityResolver({
      fetch,
      didResolver: publicDidResolver,
      handleResolver: new AtprotoHandleResolverNode({ fetch }),
      allowHttp: ALLOW_INSECURE_PDS,
      ...(env.ATPROTO_PLC_DIRECTORY_URL
        ? { plcDirectoryUrl: env.ATPROTO_PLC_DIRECTORY_URL }
        : {}),
    });
  }
  return resolver;
}

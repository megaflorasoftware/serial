/** Canonical checkpoint identity also distinguishes the two cursor domains. */
export function normalizeJetstreamEndpoint(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Jetstream service URL");
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/xrpc/network.bsky.jetstream.subscribeEvents")
    url.pathname = "/";
  return url.href.replace(/\/+$/, "");
}

export function isLegacyJetstream(service: string) {
  return new URL(service).pathname === "/subscribe";
}

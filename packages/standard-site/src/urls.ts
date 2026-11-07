const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_SOURCE_PROTOCOLS = new Set(["http:", "https:"]);

function safeUrl(value: string | undefined, protocols: Set<string>) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!protocols.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** A link destination the reader may open: http, https or mailto, no credentials. */
export function safeLinkUrl(value: string | undefined) {
  return safeUrl(value, SAFE_LINK_PROTOCOLS);
}

/** A fetchable media source: http or https only. */
export function safeSourceUrl(value: string | undefined) {
  return safeUrl(value, SAFE_SOURCE_PROTOCOLS);
}

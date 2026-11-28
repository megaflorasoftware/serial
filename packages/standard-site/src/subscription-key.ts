const SUBSCRIPTION_KEY_HEX_LENGTH = 32;

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The record key Serial writes for a Publication subscription: the first 32 hex
 * characters of SHA-256 over the publication at-uri. Standard Reader uses the same
 * derivation, so both clients converge on one record per Publication.
 */
export async function buildSubscriptionRecordKey(publicationUri: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(publicationUri),
  );
  return toHex(digest).slice(0, SUBSCRIPTION_KEY_HEX_LENGTH);
}

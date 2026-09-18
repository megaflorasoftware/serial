import {
  listedRecordSchema,
  parseDocumentRecord,
  parsePublicationRecord,
  parseSubscriptionRecord,
} from "./lexicons";
import { CID } from "multiformats/cid";
import { parseAtUri } from "./uris";

export type PublicRecordRequest = {
  uri: string;
  cid?: string;
  /** A getRecord-shaped envelope assembled from an already received event. */
  record?: unknown;
};

export class MissingPublicRecordError extends Error {}
export class PublicRecordVersionUnavailableError extends Error {}
export class PublicRecordHttpError extends Error {
  constructor(readonly status: number) {
    super(`Record fetch failed: ${status}`);
  }
}

function isRecordCid(value: string) {
  if (value.length > 256) return false;
  try {
    const cid = CID.parse(value);
    return (
      cid.version === 1 &&
      cid.code === 0x71 &&
      cid.multihash.code === 0x12 &&
      cid.multihash.size === 32
    );
  } catch {
    return false;
  }
}

export function validatePublicRecord(
  request: PublicRecordRequest,
  input: unknown,
) {
  const parts = parseAtUri(request.uri);
  if (!parts || (request.cid !== undefined && !isRecordCid(request.cid)))
    throw new Error("Invalid record identity");
  const record = listedRecordSchema.parse(input);
  if (record.uri !== request.uri) throw new Error("Record URI mismatch");
  if (
    !isRecordCid(record.cid) ||
    (request.cid !== undefined && record.cid !== request.cid)
  )
    throw new Error("Record CID mismatch");
  const parsers = {
    "site.standard.publication": parsePublicationRecord,
    "site.standard.document": parseDocumentRecord,
    "site.standard.graph.subscription": parseSubscriptionRecord,
  };
  const parser = parsers[parts.collection as keyof typeof parsers];
  if (parser) {
    if (!parser(record)) throw new Error("Invalid record value");
  } else if (
    !record.value ||
    typeof record.value !== "object" ||
    !("$type" in record.value) ||
    record.value.$type !== parts.collection
  )
    throw new Error("Invalid record value");
  return record;
}

/** The authoritative read owns the final error; a cache miss never proves deletion. */
export async function lookupPublicRecord(
  request: PublicRecordRequest,
  readers: { slingshot: () => Promise<unknown>; pds: () => Promise<unknown> },
) {
  if (
    !parseAtUri(request.uri) ||
    (request.cid !== undefined && !isRecordCid(request.cid))
  )
    throw new Error("Invalid record identity");
  if (request.record !== undefined)
    return validatePublicRecord(request, request.record);
  try {
    return validatePublicRecord(request, await readers.slingshot());
  } catch {
    return validatePublicRecord(request, await readers.pds());
  }
}

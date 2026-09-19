import {
  lookupPublicRecord,
  parseLosslessJson,
  MissingPublicRecordError,
  parseAtUri,
  PublicRecordHttpError,
  PublicRecordVersionUnavailableError,
} from "@serial/standard-site";
import type { PublicRecordRequest } from "@serial/standard-site";
import type { HardenedFetch } from "./hardened-fetch";
import { env } from "~/env";

const retryAtByService = new Map<string, number>();

export type PublicRecordOptions = {
  signal?: AbortSignal;
  /** Absolute caller deadline, including time already spent discovering this URI. */
  deadline?: number;
};

function rememberRetryDelay(service: string, response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return;
  const seconds = Number(retryAfter);
  const retryAt = Number.isFinite(seconds)
    ? Date.now() + seconds * 1000
    : Date.parse(retryAfter);
  if (retryAt > Date.now()) {
    if (!retryAtByService.has(service) && retryAtByService.size >= 256)
      retryAtByService.delete(retryAtByService.keys().next().value!);
    retryAtByService.set(
      service,
      Math.max(retryAt, retryAtByService.get(service) ?? 0),
    );
  }
}

async function readRecordResponse(
  response: Response,
  request: PublicRecordRequest,
) {
  if (response.ok) return parseLosslessJson(await response.text());
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  if (
    response.status === 404 ||
    (response.status === 400 &&
      ["RecordNotFound", "NotFound"].includes(body?.error ?? ""))
  ) {
    if (request.cid !== undefined)
      throw new PublicRecordVersionUnavailableError(
        "Record version is unavailable",
      );
    throw new MissingPublicRecordError("Record is missing");
  }
  throw new PublicRecordHttpError(response.status);
}

/** Bounds identity resolution and body consumption as well as the HTTP request. */
async function withinRecordBudget(
  duration: number,
  callerSignal: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<unknown>,
) {
  callerSignal?.throwIfAborted();
  if (duration <= 0) throw new Error("Record lookup deadline reached");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Record lookup timed out")),
    duration,
  );
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, read(signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function createPublicRecordReader(dependencies: {
  fetch: HardenedFetch;
  resolvePds: (did: string) => Promise<string>;
}) {
  return async (
    request: PublicRecordRequest,
    options: PublicRecordOptions = {},
  ) => {
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 5_000);
    const remaining = () => Math.max(0, deadline - Date.now());
    const read = (service: () => Promise<string>, duration: number) =>
      withinRecordBudget(duration, options.signal, async (signal) => {
        const base = new URL(await service());
        signal.throwIfAborted();
        if (
          !["http:", "https:"].includes(base.protocol) ||
          base.username ||
          base.password ||
          base.search ||
          base.hash
        )
          throw new Error("Invalid record service endpoint");
        const key = base.toString().replace(/\/+$/, "");
        if ((retryAtByService.get(key) ?? 0) > Date.now())
          throw new Error("Record service retry deferred");
        retryAtByService.delete(key);
        const parts = parseAtUri(request.uri)!;
        const url = new URL(`${key}/xrpc/com.atproto.repo.getRecord`);
        url.search = new URLSearchParams({
          repo: parts.did,
          collection: parts.collection,
          rkey: parts.rkey,
          ...(request.cid !== undefined ? { cid: request.cid } : {}),
        }).toString();
        const response = await dependencies.fetch(url, { signal });
        if (!response.ok) rememberRetryDelay(key, response);
        return readRecordResponse(response, request);
      });
    return lookupPublicRecord(request, {
      slingshot: () =>
        read(
          () => Promise.resolve(env.ATPROTO_SLINGSHOT_ENDPOINT),
          Math.min(1_000, Math.floor(remaining() / 2)),
        ),
      pds: () =>
        read(
          () => dependencies.resolvePds(parseAtUri(request.uri)!.did),
          remaining(),
        ),
    });
  };
}

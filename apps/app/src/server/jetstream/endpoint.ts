import WebSocket from "ws";
import { normalizeService, retryAfter, StreamFailure } from "./protocol";
import { isLegacyJetstream } from "~/lib/jetstream-endpoint";

const services = new Map<string, Promise<string>>();

/** Detect custom v1 hosts once; availability/authentication failures never downgrade. */
export function resolveStreamService(endpoint: string): Promise<string> {
  const service = normalizeService(endpoint);
  if (isLegacyJetstream(service)) return Promise.resolve(service);
  const existing = services.get(service);
  if (existing) return existing;
  const resolution = probeV2(service).catch((error: unknown) => {
    services.delete(service);
    throw error;
  });
  services.set(service, resolution);
  return resolution;
}

function probeV2(service: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(
      "/xrpc/network.bsky.jetstream.subscribeEvents",
      service,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, "xrpc.v1.json", {
      handshakeTimeout: 10_000,
    });
    socket.on("error", () => reject(new StreamFailure("protocol-detection")));
    socket.on("open", () => {
      resolve(service);
      socket.close();
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      if (response.statusCode === 404 || response.statusCode === 501)
        resolve(new URL("/subscribe", service).href);
      else if (response.statusCode === 401 || response.statusCode === 403)
        resolve(service); // Let the actual v2 connection supply configured credentials.
      else
        reject(
          new StreamFailure(
            "protocol-detection",
            response.statusCode,
            retryAfter(String(response.headers["retry-after"] ?? "")),
          ),
        );
      socket.terminate();
    });
  });
}

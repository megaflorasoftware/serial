import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";
import type { LookupFunction } from "node:net";

export class BlockedOutboundTargetError extends Error {}

/** How Serial names itself to the sites and services it reads. */
export const SERIAL_USER_AGENT = "Serial (+https://serial.tube)";

/**
 * A request's headers, naming Serial as its User-Agent. A `Request` input
 * keeps its own headers unless `init` replaces them, as fetch would.
 */
export function serialHeaders(init?: HeadersInit, input?: unknown) {
  const headers = new Headers(
    init ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("user-agent", SERIAL_USER_AGENT);
  return headers;
}

export function isPublicIpAddress(value: string) {
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.parse(value);
  } catch {
    return false;
  }

  if (address.kind() === "ipv6") {
    const ipv6Address = address as ipaddr.IPv6;
    if (ipv6Address.isIPv4MappedAddress()) {
      address = ipv6Address.toIPv4Address();
    }
  }

  return address.range() === "unicast";
}

export function validatePublicAddresses(
  results: Array<{ address: string; family: number }>,
) {
  if (
    results.length === 0 ||
    results.some((result) => !isPublicIpAddress(result.address))
  ) {
    throw new BlockedOutboundTargetError("The outbound target is not public");
  }
  return results;
}

export async function resolvePublicAddresses(hostname: string) {
  let results;
  try {
    results = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BlockedOutboundTargetError("The outbound target is unavailable");
  }

  return validatePublicAddresses(results);
}

export function validatePublicHttpUrl(value: string) {
  if (Buffer.byteLength(value, "utf8") > 8 * 1024) {
    throw new BlockedOutboundTargetError("The outbound target is too large");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BlockedOutboundTargetError("The outbound target is invalid");
  }

  const expectedPort = parsed.protocol === "http:" ? "80" : "443";
  const effectivePort = parsed.port || expectedPort;
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    effectivePort !== expectedPort
  ) {
    throw new BlockedOutboundTargetError("The outbound target is not allowed");
  }

  return parsed;
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export function createPinnedDispatcher(input: {
  address: string;
  family: 4 | 6;
  hostname: string;
}) {
  return new Agent({
    connect: {
      lookup: pinnedLookup(input.address, input.family),
      servername: input.hostname,
    },
  });
}

export type PinnedConnection = {
  dispatcher: Agent;
  release: () => Promise<void> | void;
};

/**
 * Pinned connections a run of reads shares, such as one discovery's: one per
 * hostname. Each hostname is resolved, and every address checked, once. A
 * connection serves only its own hostname, because its lookup answers with the
 * one address it was pinned to and its TLS name is fixed. Closing ends every
 * connection once no read is using one, and the pool then lends none, so a
 * later read connects on its own.
 */
export function createPinnedPool() {
  const connections = new Map<string, Promise<Agent>>();
  let lent = 0;
  let closed = false;
  const closeAll = () => {
    for (const connection of connections.values())
      void connection.then((agent) => agent.destroy()).catch(() => {});
    connections.clear();
  };
  return {
    /** The hostname's connection, opened by `open` on first use. None once closed. */
    lend(
      hostname: string,
      open: () => Promise<Agent>,
    ): Promise<PinnedConnection> | undefined {
      if (closed) return undefined;
      let connection = connections.get(hostname);
      if (!connection) {
        const opening = open();
        connection = opening;
        connections.set(hostname, opening);
        // A failed resolution is not kept; the next read resolves again.
        opening.catch(() => {
          if (connections.get(hostname) === opening)
            connections.delete(hostname);
        });
      }
      lent += 1;
      const giveBack = () => {
        lent -= 1;
        if (closed && lent === 0) closeAll();
      };
      return connection.then(
        (dispatcher) => ({ dispatcher, release: giveBack }),
        (error: unknown) => {
          giveBack();
          throw error;
        },
      );
    },
    close() {
      closed = true;
      if (lent === 0) closeAll();
    },
  };
}

export type PinnedPool = ReturnType<typeof createPinnedPool>;
